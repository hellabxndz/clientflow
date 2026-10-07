"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { createInvitation, sendInvitationEmail } from "@/lib/invitations";
import { fail, str, workspaceOf } from "@/lib/action-helpers";
import { ROLE_LABEL } from "@/lib/permissions";
import type { ActionState } from "@/components/forms";

type TeamRole = "admin" | "manager" | "staff";
const teamRole = (v: string): TeamRole | null => (v === "admin" || v === "manager" || v === "staff" ? v : null);

/** Admins invite team members as Admin, Manager or Staff. */
export async function inviteTeamMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const role = teamRole(str(fd, "role"));
    if (!role) return { error: "Choose a role." };
    const email = str(fd, "email");
    const data = await withTenant(ctx, async (tx) => {
      // createInvitation's type predates the manager role; the database accepts it and acceptance copies the role as-is.
      const invite = await createInvitation(tx, ctx, { email, role: role as "admin" | "staff" });
      const sent = await sendInvitationEmail(tx, workspaceOf(auth), invite, email, role);
      return { inviteUrl: invite.url, emailStatus: sent?.status };
    });
    revalidatePath("/app/settings/team");
    return { ok: `Invitation created for ${email} as ${ROLE_LABEL[role]}.`, data };
  } catch (e) {
    return fail(e);
  }
}

export async function updateMemberRoleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const memberId = str(fd, "memberId");
    const role = teamRole(str(fd, "role"));
    if (!role) return { error: "Choose a role." };
    const canApprove = role !== "staff" || fd.get("canApprove") === "on";
    await withTenant(ctx, async (tx) => {
      const m = await tx.one<{ user_id: string; role: string; name: string }>(
        "select m.user_id, m.role, u.name from memberships m join users u on u.id = m.user_id where m.id = $1",
        [memberId],
      );
      if (!m || m.role === "client") throw new Error("Member not found.");
      if (m.user_id === auth.user.id && role !== "admin") throw new Error("You can't remove your own admin role.");
      await tx.q("update memberships set role = $2, can_approve = $3 where id = $1", [memberId, role, canApprove]);
      await audit(tx, ctx, "member.updated", "membership", memberId, `Set ${m.name}'s role to ${ROLE_LABEL[role]}${role === "staff" ? (canApprove ? " with approval rights" : " without approval rights") : ""}`, {
        from: m.role,
        to: role,
        canApprove,
      });
    });
    revalidatePath("/app/settings/team");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}
