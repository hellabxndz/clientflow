"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { createOnboardingFromTemplate } from "@/lib/templates";
import { createInvitation, sendInvitationEmail } from "@/lib/invitations";
import { isValidTimeZone } from "@/lib/time";
import { afterWrite, fail, optional, str, workspaceOf } from "@/lib/action-helpers";
import type { ActionState } from "@/components/forms";

const RECURRENCES = ["one_time", "monthly", "annual"] as const;

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const name = str(fd, "name");
    const timezone = str(fd, "timezone") || auth.workspace.timezone;
    if (!name) return { error: "Client name is required." };
    if (name.length > 200) return { error: "Client name is too long." };
    if (!isValidTimeZone(timezone)) return { error: "Choose a valid time zone." };
    const website = optional(fd, "website");
    if (website && !/^https?:\/\/\S+$/i.test(website)) return { error: "Website must start with http:// or https://." };
    const templateId = str(fd, "templateId");
    const clientTypeId = optional(fd, "clientTypeId");
    const contactName = optional(fd, "contactName");
    const contactEmail = optional(fd, "contactEmail")?.toLowerCase() ?? null;
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return { error: "Enter a valid contact email." };

    const rawAmount = str(fd, "dealAmount").replace(/[$,\s]/g, "");
    const dealAmount = rawAmount ? Number(rawAmount) : null;
    if (dealAmount != null && (!Number.isFinite(dealAmount) || dealAmount < 0 || dealAmount >= 1e10))
      return { error: "Contract value must be a positive amount." };
    const recurrence = (str(fd, "dealRecurrence") || "one_time") as (typeof RECURRENCES)[number];
    if (!RECURRENCES.includes(recurrence)) return { error: "Choose how often the contract is billed." };

    const startRaw = str(fd, "startDate");
    if (startRaw && !/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) return { error: "Enter a valid start date." };
    const startDate = startRaw ? new Date(startRaw + "T12:00:00Z") : new Date();
    if (Number.isNaN(startDate.getTime())) return { error: "Enter a valid start date." };

    const result = await withTenant(ctx, async (tx) => {
      let ownerId = optional(fd, "ownerId");
      if (ownerId) {
        const staff = await tx.one("select 1 from memberships where user_id = $1 and role in ('admin', 'manager', 'staff')", [ownerId]);
        if (!staff) throw new Error("Choose an owner from your team.");
      }
      let typeName: string | null = null;
      if (clientTypeId) {
        const t = await tx.one<{ name: string; default_owner_user_id: string | null }>(
          "select name, default_owner_user_id from client_types where id = $1",
          [clientTypeId],
        );
        if (!t) throw new Error("That client type no longer exists.");
        typeName = t.name;
        ownerId ??= t.default_owner_user_id;
      }
      const client = await tx.one<{ id: string }>(
        `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id,
                              client_type_id, deal_amount, deal_recurrence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [auth.workspace.id, name, optional(fd, "industry"), website, timezone, contactName, contactEmail, ownerId, clientTypeId, dealAmount, recurrence],
      );
      const clientId = client!.id;
      if (contactName || contactEmail) {
        await tx.q(
          `insert into client_contacts (workspace_id, client_id, name, email, title, contact_role, phone) values ($1,$2,$3,$4,$5,'primary',$6)`,
          [auth.workspace.id, clientId, contactName ?? contactEmail, contactEmail, optional(fd, "contactTitle"), optional(fd, "contactPhone")],
        );
      }
      await audit(tx, ctx, "client.created", "client", clientId, `Created client ${name}`, {
        clientType: typeName,
        dealAmount,
        dealRecurrence: dealAmount != null ? recurrence : null,
      });
      let onboardingId: string | null = null;
      if (templateId) {
        const created = await createOnboardingFromTemplate(tx, {
          workspaceId: auth.workspace.id,
          clientId,
          templateId,
          ownerUserId: ownerId ?? auth.user.id,
          startDate,
        });
        onboardingId = created.onboardingId;
        await audit(tx, ctx, "onboarding.created", "onboarding", created.onboardingId, `Started onboarding for ${name} (template v${created.templateVersion})`);
      }
      let inviteUrl: string | null = null;
      let emailStatus: string | null = null;
      if (contactEmail && fd.get("invite") === "on") {
        const invite = await createInvitation(tx, ctx, { email: contactEmail, role: "client", clientId });
        inviteUrl = invite.url;
        const sent = await sendInvitationEmail(tx, workspaceOf(auth), invite, contactEmail, "client", name);
        emailStatus = sent?.status ?? null;
      }
      return { clientId, onboardingId, inviteUrl, emailStatus };
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: `${name} was added.`, data: result };
  } catch (e) {
    return fail(e);
  }
}
