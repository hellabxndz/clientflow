"use server";

import { revalidatePath } from "next/cache";
import { sysQuery, withSysTx, withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, str } from "@/lib/action-helpers";
import { disableMfa } from "@/lib/mfa";
import { auditAccount } from "@/lib/password-reset";
import { testScanner } from "@/lib/scanning";
import type { ActionState } from "@/components/forms";

/** Require two-step sign-in for every admin, manager and staff member of this workspace. */
export async function setRequireMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const on = fd.get("on") === "true";
    if (on && !auth.user.mfa_enabled) return { error: "Turn on two-step sign-in for your own account first, so you can't be locked out." };
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set require_staff_mfa = $2 where id = $1", [auth.workspace.id, on]);
      await audit(tx, ctx, "security.require_mfa", null, null, on ? "Required two-step sign-in for the team" : "Stopped requiring two-step sign-in for the team");
    });
    revalidatePath("/app/settings/security");
    return { ok: on ? "Two-step sign-in is now required. Team members without it will be asked to set it up." : "Two-step sign-in is now optional." };
  } catch (e) {
    return fail(e);
  }
}

/** Refuse uploads that no scanner has checked (no scanner configured, or the scanner is unreachable). */
export async function setBlockUnscannedAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const on = fd.get("on") === "true";
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set block_unscanned_uploads = $2 where id = $1", [auth.workspace.id, on]);
      await audit(tx, ctx, "security.block_unscanned", null, null, on ? "Uploads now require a successful malware scan" : "Unscanned uploads are accepted and flagged");
    });
    revalidatePath("/app/settings/security");
    return { ok: on ? "Only scanned files will be accepted." : "Unscanned files will be accepted and flagged." };
  } catch (e) {
    return fail(e);
  }
}

export async function testScannerAction(): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const result = await testScanner();
    const ctx = tenantCtx(auth);
    await withTenant(ctx, (tx) =>
      audit(tx, ctx, "security.scanner_test", null, null, result.ok ? "Malware scanner test passed" : `Malware scanner test failed: ${result.detail}`, result),
    );
    revalidatePath("/app/settings/security");
    return result.ok ? { ok: result.detail } : { error: result.detail };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Lost device: an admin clears a team member's two-step sign-in so they can set it up again.
 * Only for someone whose every workspace this admin also administers, so one workspace's admin
 * can't weaken an account another organization relies on.
 */
export async function resetMemberMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const userId = str(fd, "userId");
    if (userId === auth.user.id) return { error: "Use your account page to change your own two-step sign-in." };
    const [target] = await sysQuery<{ email: string; outside: number }>(
      `select u.email,
         (select count(*)::int from memberships m where m.user_id = u.id and not exists (
            select 1 from memberships a where a.user_id = $2 and a.workspace_id = m.workspace_id and a.role = 'admin')) as outside
       from users u where u.id = $1 and exists (select 1 from memberships m where m.user_id = u.id and m.workspace_id = $3 and m.role <> 'client')`,
      [userId, auth.user.id, auth.workspace.id],
    );
    if (!target) return { error: "That team member isn't in this workspace." };
    if (target.outside > 0) return { error: "This person also belongs to a workspace you don't administer. Ask them to use a recovery code, or contact that workspace's admin." };
    await disableMfa(userId);
    await withSysTx(async (tx) => {
      await tx.q("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
      await auditAccount(tx, userId, auth.user.id, "auth.mfa_reset_by_admin", `${auth.user.email} reset two-step sign-in for ${target.email}; their sessions were signed out`);
    });
    revalidatePath("/app/settings/security");
    return { ok: `Reset for ${target.email}. They'll be asked to set it up again at their next sign-in if it's required.` };
  } catch (e) {
    return fail(e);
  }
}
