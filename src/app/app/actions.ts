"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { tenantCtx, revokeAllSessionsForUser, revokeSession, type AuthContext } from "@/lib/auth";
import type { Tx } from "@/lib/db";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { applyTemplateUpgrade, createOnboardingFromTemplate, planTemplateUpgrade, publishTemplate, SENSITIVE_CATEGORIES, validateTemplateContent } from "@/lib/templates";
import { ACCOUNTING_TEMPLATE, AGENCY_TEMPLATE, BLANK_TEMPLATE } from "@/lib/template-library";
import { createInvitation, sendInvitationEmail } from "@/lib/invitations";
import { computeOnboardingState, unmetDependencies, type ItemLike } from "@/lib/onboarding";
import { assist, ASSIST_LABEL, type AssistKind } from "@/lib/ai";
import { runReminders, renderReminder, type ReminderRule } from "@/lib/reminders";
import { runRetention } from "@/lib/retention";
import { sendEmail } from "@/lib/email";
import { isValidTimeZone } from "@/lib/time";
import { uploadDocument } from "@/lib/files";
import { notify } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import * as h from "@/lib/action-helpers";
import { emitEvent } from "@/lib/automation/engine";
import type { ActionState } from "@/components/forms";

const str = h.str;
const optional = h.optional;
const fail = h.fail;
const workspaceOf = h.workspaceOf;
const afterWrite = h.afterWrite;

// ---------------------------------------------------------------------------
// Clients and onboardings
// ---------------------------------------------------------------------------

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const name = str(fd, "name");
    const timezone = str(fd, "timezone") || auth.workspace.timezone;
    if (!name) return { error: "Client name is required." };
    if (!isValidTimeZone(timezone)) return { error: "Choose a valid time zone." };
    const templateId = str(fd, "templateId");
    const contactEmail = optional(fd, "contactEmail");
    const startDate = str(fd, "startDate") ? new Date(str(fd, "startDate") + "T12:00:00Z") : new Date();
    const result = await withTenant(ctx, async (tx) => {
      const client = await tx.one<{ id: string }>(
        `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [auth.workspace.id, name, optional(fd, "industry"), optional(fd, "website"), timezone, optional(fd, "contactName"), contactEmail, optional(fd, "ownerId")],
      );
      await audit(tx, ctx, "client.created", "client", client!.id, `Created client ${name}`);
      if (templateId) {
        const { onboardingId, templateVersion } = await createOnboardingFromTemplate(tx, {
          workspaceId: auth.workspace.id,
          clientId: client!.id,
          templateId,
          ownerUserId: optional(fd, "ownerId") ?? auth.user.id,
          startDate,
        });
        await audit(tx, ctx, "onboarding.created", "onboarding", onboardingId, `Started onboarding for ${name} (template v${templateVersion})`);
      }
      let inviteUrl: string | null = null;
      let emailStatus: string | null = null;
      if (contactEmail && fd.get("invite") === "on") {
        const invite = await createInvitation(tx, ctx, { email: contactEmail, role: "client", clientId: client!.id });
        inviteUrl = invite.url;
        const sent = await sendInvitationEmail(tx, workspaceOf(auth), invite, contactEmail, "client", name);
        emailStatus = sent?.status ?? null;
      }
      return { clientId: client!.id, inviteUrl, emailStatus };
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app");
    return { ok: `${name} was added.`, data: result };
  } catch (e) {
    return fail(e);
  }
}

export async function startOnboardingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const clientId = str(fd, "clientId");
    await withTenant(ctx, async (tx) => {
      const active = await tx.one("select 1 from onboardings where client_id = $1 and status in ('active', 'paused')", [clientId]);
      if (active) throw new Error("This client already has an onboarding in progress.");
      const { onboardingId, templateVersion } = await createOnboardingFromTemplate(tx, {
        workspaceId: auth.workspace.id,
        clientId,
        templateId: str(fd, "templateId"),
        ownerUserId: optional(fd, "ownerId") ?? auth.user.id,
      });
      await audit(tx, ctx, "onboarding.created", "onboarding", onboardingId, `Started onboarding (template v${templateVersion})`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath(`/app/clients/${clientId}`);
    return { ok: "Onboarding started." };
  } catch (e) {
    return fail(e);
  }
}

export async function inviteContactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const clientId = str(fd, "clientId");
    const email = str(fd, "email");
    const data = await withTenant(ctx, async (tx) => {
      const client = await tx.one<{ name: string }>("select name from clients where id = $1", [clientId]);
      if (!client) throw new Error("Client not found.");
      const invite = await createInvitation(tx, ctx, { email, role: "client", clientId });
      const sent = await sendInvitationEmail(tx, workspaceOf(auth), invite, email, "client", client.name);
      return { inviteUrl: invite.url, emailStatus: sent?.status };
    });
    revalidatePath(`/app/clients/${clientId}`);
    return { ok: `Invitation created for ${email}.`, data };
  } catch (e) {
    return fail(e);
  }
}

export async function setOnboardingStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const to = str(fd, "status");
    if (!["active", "paused", "cancelled"].includes(to)) return { error: "Invalid status." };
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ status: string; client_id: string }>("select status, client_id from onboardings where id = $1", [id]);
      if (!o) throw new Error("Onboarding not found.");
      if (o.status === "completed") throw new Error("Completed onboardings can't be changed.");
      if (o.status === to) return;
      await tx.q(
        `update onboardings set status = $2, paused_at = case when $2 = 'paused' then now() else paused_at end where id = $1`,
        [id, to],
      );
      await audit(tx, ctx, `onboarding.${to === "active" ? "resumed" : to}`, "onboarding", id, `Onboarding ${to === "active" ? "resumed" : to}`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: to === "paused" ? "Onboarding paused. Reminders are stopped." : to === "active" ? "Onboarding resumed." : "Onboarding cancelled." };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleOnboardingRemindersAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const enabled = str(fd, "enabled") === "true";
    await withTenant(ctx, async (tx) => {
      await tx.q("update onboardings set reminders_enabled = $2 where id = $1", [id, enabled]);
      await audit(tx, ctx, "onboarding.reminders", "onboarding", id, `Automatic reminders ${enabled ? "enabled" : "turned off"} for this onboarding`);
    });
    revalidatePath("/app", "layout");
    return { ok: enabled ? "Reminders on." : "Reminders off for this client." };
  } catch (e) {
    return fail(e);
  }
}

export async function approveCompletionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    if (!auth.canApprove) return { error: "You don't have permission to approve onboarding completion. Ask an admin." };
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ id: string; status: "active" | "paused" | "completed" | "cancelled"; owner_user_id: string | null }>(
        "select id, status, owner_user_id from onboardings where id = $1 for update",
        [id],
      );
      if (!o) throw new Error("Onboarding not found.");
      if (o.status !== "active") throw new Error("Only active onboardings can be completed.");
      const items = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [id]);
      const state = computeOnboardingState(o, items);
      if (!state.readyForCompletion)
        throw new Error(
          state.progress.requiredTotal === 0
            ? "This onboarding has no required items to approve."
            : `${state.progress.requiredTotal - state.progress.requiredApproved} required item(s) are not approved yet.`,
        );
      await tx.q("update onboardings set status = 'completed', completed_at = now(), completed_by = $2, completion_note = $3 where id = $1", [
        id,
        auth.user.id,
        optional(fd, "note"),
      ]);
      await audit(tx, ctx, "onboarding.completed", "onboarding", id, `Approved onboarding completion`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Onboarding marked complete. The client is ready to start." };
  } catch (e) {
    return fail(e);
  }
}

/** Marks (or clears) Ready for Kickoff by hand. The database emits ready_for_kickoff so handoff rules run. */
export async function markReadyForKickoffAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    if (!auth.canApprove) return { error: "You don't have approval permission, so you can't mark clients Ready for Kickoff." };
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const ready = str(fd, "ready") !== "false";
    const msg = await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ status: string; kickoff_ready_at: Date | null; owner_user_id: string | null }>(
        "select status, kickoff_ready_at, owner_user_id from onboardings where id = $1 for update",
        [id],
      );
      if (!o) throw new Error("Onboarding not found.");
      if (o.status !== "active") throw new Error("Only active onboardings can be marked Ready for Kickoff.");
      if (ready) {
        if (o.kickoff_ready_at) throw new Error("This client is already Ready for Kickoff.");
        const items = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [id]);
        const state = computeOnboardingState({ id, status: "active", owner_user_id: o.owner_user_id }, items);
        const outstanding = state.progress.requiredTotal - state.progress.requiredApproved;
        await tx.q("update onboardings set kickoff_ready_at = now() where id = $1", [id]);
        await audit(tx, ctx, "onboarding.ready_for_kickoff", "onboarding", id,
          `Marked Ready for Kickoff manually${outstanding ? ` with ${outstanding} required item${outstanding === 1 ? "" : "s"} still outstanding` : ""}`,
          { outstanding, readiness: state.readiness.score });
        return "Marked Ready for Kickoff. Handoff automations will run.";
      }
      if (!o.kickoff_ready_at) throw new Error("This client isn't marked Ready for Kickoff.");
      await tx.q("update onboardings set kickoff_ready_at = null where id = $1", [id]);
      await audit(tx, ctx, "onboarding.ready_cleared", "onboarding", id, "Cleared Ready for Kickoff");
      return "Ready for Kickoff cleared.";
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: msg };
  } catch (e) {
    return fail(e);
  }
}

export async function setKickoffDateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const date = str(fd, "kickoffDate");
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T12:00:00Z")))) return { error: "Choose a valid date." };
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ status: string }>("select status from onboardings where id = $1", [id]);
      if (!o) throw new Error("Onboarding not found.");
      if (o.status === "cancelled") throw new Error("This onboarding was cancelled.");
      await tx.q("update onboardings set kickoff_date = $2 where id = $1", [id, date || null]);
      await audit(tx, ctx, "onboarding.kickoff_date", "onboarding", id, date ? `Set kickoff date to ${date}` : "Cleared the kickoff date");
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: date ? "Kickoff date saved." : "Kickoff date cleared." };
  } catch (e) {
    return fail(e);
  }
}

export async function setAtRiskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const atRisk = str(fd, "atRisk") === "true";
    const reason = str(fd, "reason").slice(0, 500);
    if (atRisk && reason.length < 3) return { error: "Say why this client is at risk." };
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ status: string }>("select status from onboardings where id = $1", [id]);
      if (!o) throw new Error("Onboarding not found.");
      await tx.q(
        `update onboardings set at_risk = $2, at_risk_reason = case when $2 then $3 else null end,
           at_risk_at = case when $2 then now() else null end where id = $1`,
        [id, atRisk, reason || null],
      );
      await audit(tx, ctx, atRisk ? "onboarding.at_risk" : "onboarding.at_risk_cleared", "onboarding", id,
        atRisk ? `Flagged At Risk: ${reason}` : "Cleared the At Risk flag");
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: atRisk ? "Flagged At Risk." : "At Risk flag cleared." };
  } catch (e) {
    return fail(e);
  }
}

/** Managers can drop a requirement from a live onboarding. Its history and files are kept. */
export async function removeRequirementAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    const reason = str(fd, "reason").slice(0, 300);
    await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      if (item.onboarding_status === "completed" || item.onboarding_status === "cancelled") throw new Error("This onboarding is closed.");
      if (item.removed_at) throw new Error("This requirement was already removed.");
      await tx.q("update onboarding_items set removed_at = now(), updated_at = now() where id = $1", [itemId]);
      const dependents = await tx.q<{ title: string }>(
        "select title from onboarding_items where onboarding_id = $1 and removed_at is null and $2 = any(depends_on)",
        [item.onboarding_id, item.item_key],
      );
      await audit(tx, ctx, "item.removed", "item", itemId,
        `Removed requirement "${item.title}"${reason ? `: ${reason}` : ""}${dependents.length ? ` (no longer blocks ${dependents.map((d) => `"${d.title}"`).join(", ")})` : ""}`,
        { reason, required: item.required });
      // Removing the last outstanding requirement completes the checklist even though no status changed.
      const left = await tx.one<{ open: number; total: number }>(
        `select count(*) filter (where status <> 'approved')::int as open, count(*)::int as total
         from onboarding_items where onboarding_id = $1 and required and removed_at is null`,
        [item.onboarding_id],
      );
      if (item.required && item.status !== "approved" && left && left.total > 0 && left.open === 0)
        await emitEvent(tx, {
          workspace_id: auth.workspace.id,
          type: "all_required_completed",
          client_id: item.client_id,
          onboarding_id: item.onboarding_id,
          item_id: null,
          payload: { via: "requirement_removed" },
          actorUserId: auth.user.id,
        });
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Requirement removed. It no longer counts toward readiness and the client no longer sees it." };
  } catch (e) {
    return fail(e);
  }
}

export async function restoreRequirementAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      if (!item.removed_at) throw new Error("This requirement is not removed.");
      if (item.onboarding_status === "completed" || item.onboarding_status === "cancelled") throw new Error("This onboarding is closed.");
      await tx.q("update onboarding_items set removed_at = null, updated_at = now() where id = $1", [itemId]);
      await audit(tx, ctx, "item.restored", "item", itemId, `Restored requirement "${item.title}"`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Requirement restored." };
  } catch (e) {
    return fail(e);
  }
}

/** Read-only: what upgrading this onboarding to the latest published template version would change. */
export async function previewTemplateUpgradeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const plan = await withTenant(tenantCtx(auth), (tx) => planTemplateUpgrade(tx, str(fd, "onboardingId")));
    if (!plan) return { ok: "This onboarding already uses the latest template version." };
    return { ok: "", data: plan };
  } catch (e) {
    return fail(e);
  }
}

export async function applyTemplateUpgradeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    if (!can(auth.role, "upgradeOnboardings")) return { error: "Only managers can upgrade onboardings." };
    if (!h.bool(fd, "confirm")) return { error: "Confirm that you reviewed the changes before applying the upgrade." };
    const ctx = tenantCtx(auth);
    const id = str(fd, "onboardingId");
    const plan = await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ status: string; template_name: string | null }>("select status, template_name from onboardings where id = $1", [id]);
      if (!o) throw new Error("Onboarding not found.");
      if (o.status === "completed" || o.status === "cancelled") throw new Error("Closed onboardings can't be upgraded.");
      const expected = str(fd, "toVersion");
      const preview = await planTemplateUpgrade(tx, id);
      if (!preview) throw new Error("This onboarding already uses the latest template version.");
      if (expected && Number(expected) !== preview.toVersion)
        throw new Error(`A newer version (v${preview.toVersion}) was published since you previewed. Preview again.`);
      const p = await applyTemplateUpgrade(tx, id);
      await audit(tx, ctx, "onboarding.template_upgraded", "onboarding", id,
        `Upgraded ${o.template_name ?? "template"} from v${p.fromVersion ?? "?"} to v${p.toVersion}: ${p.added.length} added, ${p.updated.length} updated, ${p.keptStarted.length + p.keptRemoved.length} kept because started, ${p.removed.length} removed`,
        { added: p.added.map((a) => a.key), updated: p.updated.map((u) => u.key), kept: p.keptStarted.map((k) => k.key), removed: p.removed.map((r) => r.key) });
      return p;
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: `Upgraded to v${plan.toVersion}.`, data: plan };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Items, reviews, tasks, comments
// ---------------------------------------------------------------------------

interface LockedItem {
  id: string;
  item_key: string;
  title: string;
  status: string;
  audience: string;
  kind: string;
  required: boolean;
  category: string | null;
  reviewer_user_id: string | null;
  removed_at: Date | null;
  client_id: string;
  client_name: string;
  onboarding_id: string;
  onboarding_status: string;
}

async function lockItem(tx: Tx, itemId: string) {
  const item = await tx.one<LockedItem>(
    `select i.id, i.item_key, i.title, i.status, i.audience, i.kind, i.required, i.category, i.reviewer_user_id, i.removed_at,
            i.client_id, c.name as client_name, i.onboarding_id, o.status as onboarding_status
     from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
     where i.id = $1 for update of i`,
    [itemId],
  );
  if (!item) throw new Error("Item not found.");
  return item;
}

function assertReviewable(item: LockedItem) {
  if (item.onboarding_status === "completed") throw new Error("This onboarding is already complete.");
  if (item.onboarding_status === "cancelled") throw new Error("This onboarding was cancelled.");
  if (item.removed_at) throw new Error("This requirement was removed from the onboarding.");
}

async function insertComment(tx: Tx, auth: AuthContext, item: { client_id: string; onboarding_id: string; id: string | null }, visibility: "client" | "internal", body: string) {
  await tx.q(
    "insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body) values ($1,$2,$3,$4,$5,$6,$7)",
    [auth.workspace.id, item.client_id, item.onboarding_id, item.id, auth.user.id, visibility, body.slice(0, 5000)],
  );
}

export async function addQuestionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const onboardingId = str(fd, "onboardingId");
    const question = str(fd, "question");
    if (question.length < 5) return { error: "Write the question for the client." };
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ client_id: string }>("select client_id from onboardings where id = $1", [onboardingId]);
      if (!o) throw new Error("Onboarding not found.");
      const [{ pos }] = await tx.q<{ pos: number }>("select coalesce(max(position), 0) + 1 as pos from onboarding_items where onboarding_id = $1", [onboardingId]);
      const due = str(fd, "dueDate") ? new Date(str(fd, "dueDate") + "T17:00:00Z") : null;
      const item = await tx.one<{ id: string }>(
        `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key, position, kind, title,
           description, audience, required, due_at, owner_user_id)
         values ($1,$2,$3,'questions','Questions from the team',$4,$5,'question',$6,$7,'client',$8,$9,$10) returning id`,
        [auth.workspace.id, o.client_id, onboardingId, `q_${Date.now().toString(36)}`, pos, question.slice(0, 200), question.length > 200 ? question : null, fd.get("required") === "on", due, auth.user.id],
      );
      await audit(tx, ctx, "item.question_added", "item", item!.id, `Asked the client: ${question.slice(0, 120)}`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Question sent to the client's checklist." };
  } catch (e) {
    return fail(e);
  }
}

export async function addTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const onboardingId = str(fd, "onboardingId");
    const title = str(fd, "title");
    if (!title) return { error: "Give the task a title." };
    const deps = fd.getAll("dependsOn").map(String).filter(Boolean);
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ client_id: string }>("select client_id from onboardings where id = $1", [onboardingId]);
      if (!o) throw new Error("Onboarding not found.");
      if (deps.length) {
        const found = await tx.q("select item_key from onboarding_items where onboarding_id = $1 and item_key = any($2)", [onboardingId, deps]);
        if (found.length !== deps.length) throw new Error("A dependency was not found.");
      }
      const [{ pos }] = await tx.q<{ pos: number }>("select coalesce(max(position), 0) + 1 as pos from onboarding_items where onboarding_id = $1", [onboardingId]);
      const due = str(fd, "dueDate") ? new Date(str(fd, "dueDate") + "T17:00:00Z") : null;
      const item = await tx.one<{ id: string }>(
        `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key, position, kind, title,
           audience, required, due_at, owner_user_id, depends_on)
         values ($1,$2,$3,'team_tasks','Team tasks',$4,$5,'task',$6,'internal',$7,$8,$9,$10) returning id`,
        [auth.workspace.id, o.client_id, onboardingId, `t_${Date.now().toString(36)}`, pos, title.slice(0, 200), fd.get("required") === "on", due, optional(fd, "ownerId"), deps],
      );
      await audit(tx, ctx, "task.created", "item", item!.id, `Created task "${title.slice(0, 120)}"`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Task added." };
  } catch (e) {
    return fail(e);
  }
}

/** Submitted → Under Review. The person starting the review becomes the reviewer if none is assigned. */
export async function startReviewAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      assertReviewable(item);
      if (item.status !== "submitted") throw new Error(item.status === "under_review" ? "This item is already under review." : "Only submitted items can be reviewed.");
      await tx.q(
        "update onboarding_items set status = 'under_review', reviewer_user_id = coalesce(reviewer_user_id, $2), updated_at = now() where id = $1",
        [itemId, auth.user.id],
      );
      await audit(tx, ctx, "item.review_started", "item", itemId, `Started reviewing "${item.title}"`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Review started. The client can't edit this item until you respond." };
  } catch (e) {
    return fail(e);
  }
}

export async function reviewItemAction(prev: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const decision = str(fd, "decision");
    if (decision === "start") return startReviewAction(prev, fd);
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    const note = str(fd, "note");
    const internalNote = str(fd, "internalNote");
    if (decision !== "approve" && decision !== "changes") return { error: "Choose approve or request changes." };
    if (!auth.canApprove) return { error: "You don't have approval permission. Ask an admin to grant it, or reassign the review." };
    if (decision === "changes" && note.length < 3) return { error: "Tell the client what needs to change." };
    await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      assertReviewable(item);
      if (item.kind === "task") throw new Error("Internal tasks are marked done, not reviewed.");
      if (item.status === "approved") throw new Error("This item is already approved.");
      if (decision === "changes" && item.status !== "submitted" && item.status !== "under_review")
        throw new Error("Only submitted items can be sent back. Leave the client a comment instead.");
      if (decision === "approve" && item.kind === "file") {
        const docs = await tx.q<{ review_status: string; scan_status: string }>(
          `select distinct on (v.document_id) v.review_status, v.scan_status from document_versions v join documents d on d.id = v.document_id
           where d.item_id = $1 order by v.document_id, v.version desc`,
          [itemId],
        );
        if (docs.length === 0) throw new Error("There are no files to approve yet.");
        if (docs.some((d) => d.scan_status === "infected")) throw new Error("A file on this request was flagged by the scanner.");
        if (docs.some((d) => d.review_status === "rejected" || d.review_status === "changes_requested"))
          throw new Error("The latest version of a file was sent back. Wait for a new upload, or accept that file first.");
      }
      const status = decision === "approve" ? "approved" : "changes_requested";
      await tx.q(
        `update onboarding_items set status = $2, reviewed_at = now(), reviewed_by = $3, reviewer_user_id = coalesce(reviewer_user_id, $3), updated_at = now()
         where id = $1`,
        [itemId, status, auth.user.id],
      );
      if (item.kind === "file") {
        // The latest version of each document follows the item decision unless it was already decided individually.
        await tx.q(
          `update document_versions v set review_status = $2, reviewed_by = $3, reviewed_at = now(), review_note = coalesce(nullif($4, ''), v.review_note)
           where v.review_status = 'pending' and v.id in (
             select distinct on (v2.document_id) v2.id from document_versions v2 join documents d on d.id = v2.document_id
             where d.item_id = $1 order by v2.document_id, v2.version desc)`,
          [itemId, status, auth.user.id, note],
        );
      }
      if (note) await insertComment(tx, auth, item, item.audience === "client" ? "client" : "internal", note);
      if (internalNote) await insertComment(tx, auth, item, "internal", internalNote);
      const sensitive = !!item.category && SENSITIVE_CATEGORIES.has(item.category);
      await audit(tx, ctx, decision === "approve" ? "item.approved" : "item.changes_requested", "item", itemId,
        `${decision === "approve" ? "Approved" : "Requested changes on"} "${item.title}"`, { category: item.category, sensitive, humanReview: true });
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: decision === "approve" ? "Approved." : "Changes requested. The client will see your note." };
  } catch (e) {
    return fail(e);
  }
}

/** Assigns (or clears) the staff member responsible for reviewing an item, and notifies them. */
export async function reassignReviewerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    if (!can(auth.role, "reassignReviews")) return { error: "You can't reassign reviews." };
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    const reviewerId = optional(fd, "reviewerId");
    const msg = await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      assertReviewable(item);
      let reviewerName: string | null = null;
      if (reviewerId) {
        const m = await tx.one<{ name: string }>(
          "select u.name from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.role in ('admin', 'manager', 'staff')",
          [reviewerId],
        );
        if (!m) throw new Error("Choose a team member in this workspace.");
        reviewerName = m.name;
      }
      if ((item.reviewer_user_id ?? null) === reviewerId) return "No change.";
      await tx.q("update onboarding_items set reviewer_user_id = $2, updated_at = now() where id = $1", [itemId, reviewerId]);
      await audit(tx, ctx, "item.reviewer_assigned", "item", itemId,
        reviewerId ? `Assigned ${reviewerName} to review "${item.title}"` : `Cleared the reviewer on "${item.title}"`, { reviewerId });
      if (reviewerId && reviewerId !== auth.user.id)
        await notify(tx, {
          workspace: workspaceOf(auth),
          userIds: [reviewerId],
          kind: "review_assigned",
          title: `${auth.user.name} assigned you to review "${item.title}" for ${item.client_name}`,
          body: item.status === "submitted" || item.status === "under_review" ? "It's waiting in your review queue." : "You'll review it once the client submits it.",
          link: `/app/clients/${item.client_id}/items/${item.id}`,
          onboardingId: item.onboarding_id,
        });
      return reviewerId ? `${reviewerName} is now the reviewer.` : "Reviewer cleared.";
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: msg };
  } catch (e) {
    return fail(e);
  }
}

export async function reopenItemAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    await withTenant(ctx, async (tx) => {
      const item = await lockItem(tx, itemId);
      assertReviewable(item);
      await tx.q("update onboarding_items set status = $2, reviewed_at = null, reviewed_by = null, updated_at = now() where id = $1", [
        itemId,
        item.audience === "client" ? "changes_requested" : "in_progress",
      ]);
      await audit(tx, ctx, "item.reopened", "item", itemId, `Reopened "${item.title}"`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Reopened." };
  } catch (e) {
    return fail(e);
  }
}

export async function updateItemAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    const due = str(fd, "dueDate") ? new Date(str(fd, "dueDate") + "T17:00:00Z") : null;
    await withTenant(ctx, async (tx) => {
      const item = await tx.one<{ title: string }>(
        "update onboarding_items set due_at = $2, owner_user_id = $3, required = $4, updated_at = now() where id = $1 returning title",
        [itemId, due, optional(fd, "ownerId"), fd.get("required") === "on"],
      );
      if (!item) throw new Error("Item not found.");
      await audit(tx, ctx, "item.updated", "item", itemId, `Updated due date, owner or requirement for "${item.title}"`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function setTaskStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const itemId = str(fd, "itemId");
    const status = str(fd, "status");
    if (!["not_started", "in_progress", "approved"].includes(status)) return { error: "Invalid status." };
    await withTenant(ctx, async (tx) => {
      const item = await tx.one<ItemLike & { onboarding_id: string; onboarding_status: string }>(
        `select i.*, o.status as onboarding_status from onboarding_items i join onboardings o on o.id = i.onboarding_id where i.id = $1 for update of i`,
        [itemId],
      );
      if (!item || item.audience !== "internal") throw new Error("Task not found.");
      if (item.onboarding_status === "completed") throw new Error("This onboarding is already complete.");
      if (item.removed_at) throw new Error("This task was removed from the onboarding.");
      if (status === "approved") {
        const siblings = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
        const unmet = unmetDependencies(item, new Map(siblings.map((s) => [s.item_key, s])));
        if (unmet.length) throw new Error(`Blocked: waiting on ${unmet.map((u) => `"${u.title}"`).join(", ")}.`);
      }
      await tx.q(
        "update onboarding_items set status = $2, updated_at = now(), reviewed_at = case when $2 = 'approved' then now() else null end, reviewed_by = case when $2 = 'approved' then $3::uuid else null end where id = $1",
        [itemId, status, auth.user.id],
      );
      await audit(tx, ctx, "task.status", "item", itemId, `Marked task "${item.title}" ${status === "approved" ? "done" : status.replace("_", " ")}`);
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Updated." };
  } catch (e) {
    return fail(e);
  }
}

export async function addCommentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const body = str(fd, "body");
    const visibility = str(fd, "visibility") === "client" ? "client" : "internal";
    if (!body) return { error: "Write a message first." };
    const itemId = optional(fd, "itemId");
    await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ client_id: string }>("select client_id from onboardings where id = $1", [str(fd, "onboardingId")]);
      if (!o) throw new Error("Onboarding not found.");
      if (itemId) {
        const item = await tx.one<{ audience: string }>("select audience from onboarding_items where id = $1 and onboarding_id = $2", [itemId, str(fd, "onboardingId")]);
        if (!item) throw new Error("Item not found.");
        if (item.audience === "internal" && visibility === "client") throw new Error("Internal tasks can only have internal notes.");
      }
      await insertComment(tx, auth, { client_id: o.client_id, onboarding_id: str(fd, "onboardingId"), id: itemId }, visibility, body);
      await audit(tx, ctx, visibility === "client" ? "comment.client" : "comment.internal", itemId ? "item" : "onboarding", itemId ?? str(fd, "onboardingId"),
        `${visibility === "client" ? "Messaged the client" : "Added an internal note"}: ${body.slice(0, 120)}`);
    });
    revalidatePath("/app", "layout");
    return { ok: visibility === "client" ? "Sent to the client." : "Internal note saved." };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Review one file version: approve, request changes, or reject. Rejecting or requesting changes sends the
 * request back to the client. Optionally records an expiry date and a note (client-visible or internal).
 */
export async function reviewDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const versionId = str(fd, "versionId");
    const decision = str(fd, "decision");
    const note = str(fd, "note");
    const noteVisibility = str(fd, "noteVisibility") === "internal" ? "internal" : "client";
    const expiresRaw = fd.has("expiresOn") ? str(fd, "expiresOn") : undefined;
    if (!["approved", "changes_requested", "rejected"].includes(decision)) return { error: "Invalid decision." };
    if (!auth.canApprove) return { error: "You don't have approval permission. Ask an admin, or reassign the review." };
    if (decision !== "approved" && note.length < 3) return { error: "Add a note explaining what's wrong with the file." };
    if (decision !== "approved" && noteVisibility === "internal") return { error: "The client needs to see why the file was sent back. Make the note visible to the client." };
    if (expiresRaw && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresRaw) || Number.isNaN(Date.parse(expiresRaw)))) return { error: "Choose a valid expiry date." };
    const msg = await withTenant(ctx, async (tx) => {
      const v = await tx.one<{ original_name: string; scan_status: string; item_id: string; client_id: string; onboarding_id: string; is_latest: boolean }>(
        `select v.original_name, v.scan_status, d.item_id, d.client_id, d.onboarding_id,
                v.version = (select max(v2.version) from document_versions v2 where v2.document_id = v.document_id) as is_latest
         from document_versions v join documents d on d.id = v.document_id where v.id = $1`,
        [versionId],
      );
      if (!v) throw new Error("File not found.");
      const item = await lockItem(tx, v.item_id);
      assertReviewable(item);
      if (decision === "approved" && v.scan_status === "infected") throw new Error("Infected files can't be approved.");
      await tx.q(
        `update document_versions set review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
           expires_on = case when $5::boolean then $6::date else expires_on end where id = $1`,
        [versionId, decision, note || null, auth.user.id, expiresRaw !== undefined, expiresRaw || null],
      );
      let itemMsg = "";
      if (decision !== "approved" && v.is_latest && item.status !== "changes_requested") {
        await tx.q(
          `update onboarding_items set status = 'changes_requested', reviewed_at = now(), reviewed_by = $2,
             reviewer_user_id = coalesce(reviewer_user_id, $2), updated_at = now() where id = $1`,
          [v.item_id, auth.user.id],
        );
        itemMsg = " The request is back with the client.";
      }
      if (note) await insertComment(tx, auth, item, noteVisibility, `${v.original_name}: ${note}`);
      if (decision === "approved" && h.bool(fd, "approveItem") && (item.status === "submitted" || item.status === "under_review")) {
        const open = await tx.one<{ n: number }>(
          `select count(*)::int as n from (select distinct on (v.document_id) v.review_status from document_versions v join documents d on d.id = v.document_id
           where d.item_id = $1 order by v.document_id, v.version desc) latest where review_status <> 'approved'`,
          [v.item_id],
        );
        if (open?.n === 0) {
          await tx.q(
            `update onboarding_items set status = 'approved', reviewed_at = now(), reviewed_by = $2, reviewer_user_id = coalesce(reviewer_user_id, $2),
               updated_at = now() where id = $1`,
            [v.item_id, auth.user.id],
          );
          await audit(tx, ctx, "item.approved", "item", v.item_id, `Approved "${item.title}"`, { category: item.category, humanReview: true });
          itemMsg = " The request is approved.";
        } else itemMsg = " Other files on this request still need a decision.";
      }
      const verb = decision === "approved" ? "Accepted" : decision === "rejected" ? "Rejected" : "Requested changes on";
      await audit(tx, ctx, `document.${decision}`, "document_version", versionId,
        `${verb} file "${v.original_name}"${expiresRaw ? ` (expires ${expiresRaw})` : ""}`, { category: item.category, humanReview: true });
      return `${decision === "approved" ? "File accepted." : decision === "rejected" ? "File rejected." : "Changes requested."}${itemMsg}`;
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: msg };
  } catch (e) {
    return fail(e);
  }
}

export async function setDocumentExpiryAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const versionId = str(fd, "versionId");
    const date = str(fd, "expiresOn");
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) return { error: "Choose a valid date." };
    await withTenant(ctx, async (tx) => {
      const v = await tx.one<{ original_name: string }>("update document_versions set expires_on = $2 where id = $1 returning original_name", [versionId, date || null]);
      if (!v) throw new Error("File not found.");
      await audit(tx, ctx, "document.expiry", "document_version", versionId, date ? `Set "${v.original_name}" to expire on ${date}` : `Cleared the expiry date on "${v.original_name}"`);
    });
    revalidatePath("/app", "layout");
    return { ok: date ? "Expiry date saved." : "Expiry date cleared." };
  } catch (e) {
    return fail(e);
  }
}

export async function staffUploadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };
    const result = await uploadDocument(tenantCtx(auth), {
      itemId: str(fd, "itemId"),
      documentId: optional(fd, "documentId"),
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
    if (!result.ok) return { error: result.error };
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: "Uploaded." };
  } catch (e) {
    return fail(e);
  }
}

export async function aiAssistAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const kind = str(fd, "kind") as AssistKind;
    if (!(kind in ASSIST_LABEL)) return { error: "Unknown request." };
    const result = await assist(tenantCtx(auth), str(fd, "onboardingId"), kind);
    if (!result) return { error: "Onboarding not found." };
    return { ok: "", data: { ...result, kind } };
  } catch (e) {
    return fail(e);
  }
}

export async function sendManualMessageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const body = str(fd, "body");
    const subject = str(fd, "subject") || `A note from ${auth.workspace.name}`;
    if (body.length < 10) return { error: "The message is empty." };
    const result = await withTenant(ctx, async (tx) => {
      const o = await tx.one<{ id: string; client_id: string; email: string | null }>(
        `select o.id, o.client_id, coalesce(
           (select u.email from memberships m join users u on u.id = m.user_id where m.client_id = o.client_id and m.role = 'client' order by m.created_at limit 1),
           c.primary_contact_email) as email
         from onboardings o join clients c on c.id = o.client_id where o.id = $1`,
        [str(fd, "onboardingId")],
      );
      if (!o || !o.email) throw new Error("This client has no contact email.");
      const sent = await sendEmail(tx, workspaceOf(auth), {
        workspaceId: auth.workspace.id,
        kind: "notification",
        to: o.email,
        subject,
        body,
        onboardingId: o.id,
      });
      await audit(tx, ctx, "email.manual", "onboarding", o.id, `Sent a message to ${o.email} (${sent?.status})`);
      return sent;
    });
    revalidatePath("/app", "layout");
    if (result?.status === "failed") return { error: `Not sent: ${result.error}` };
    return { ok: result?.status === "simulated" ? "Recorded in the demo outbox (not actually sent)." : "Email sent." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function assertCanEditTemplates(auth: AuthContext) {
  if (auth.workspace.template_edit_role === "admin" && auth.role !== "admin" && auth.role !== "manager")
    throw new Error("Only admins and managers can edit templates in this workspace.");
}

export async function createTemplateAction(fd: FormData) {
  const auth = await actionAuth("staff");
  assertCanEditTemplates(auth);
  const ctx = tenantCtx(auth);
  const source = str(fd, "source");
  const base = source === "agency" ? AGENCY_TEMPLATE : source === "accounting" ? ACCOUNTING_TEMPLATE : { name: "Untitled template", description: "", category: "general", content: BLANK_TEMPLATE };
  const id = await withTenant(ctx, async (tx) => {
    const row = await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [auth.workspace.id, source === "blank" ? "Untitled template" : `${base.name} (copy)`, base.description, base.category, JSON.stringify(base.content), auth.user.id],
    );
    await audit(tx, ctx, "template.created", "template", row!.id, `Created template from ${source}`);
    return row!.id;
  });
  redirect(`/app/templates/${id}`);
}

export async function duplicateTemplateAction(fd: FormData) {
  const auth = await actionAuth("staff");
  assertCanEditTemplates(auth);
  const ctx = tenantCtx(auth);
  const id = await withTenant(ctx, async (tx) => {
    const t = await tx.one<{ name: string; description: string; category: string; draft: unknown }>("select * from templates where id = $1", [str(fd, "templateId")]);
    if (!t) throw new Error("Template not found");
    const row = await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [auth.workspace.id, `${t.name} (copy)`, t.description, t.category, JSON.stringify(t.draft), auth.user.id],
    );
    await audit(tx, ctx, "template.duplicated", "template", row!.id, `Duplicated template "${t.name}"`);
    return row!.id;
  });
  redirect(`/app/templates/${id}`);
}

export async function saveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    assertCanEditTemplates(auth);
    const ctx = tenantCtx(auth);
    const id = str(fd, "templateId");
    const name = str(fd, "name");
    if (!name) return { error: "Template name is required." };
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "content"));
    } catch {
      return { error: "Template content is not valid." };
    }
    const valid = validateTemplateContent(raw);
    if (!valid.ok) return { error: valid.errors.slice(0, 5).join(" ") };
    await withTenant(ctx, async (tx) => {
      const t = await tx.one("update templates set name = $2, description = $3, category = $4, draft = $5, updated_at = now() where id = $1 returning id", [
        id,
        name,
        optional(fd, "description"),
        str(fd, "category") || "general",
        JSON.stringify(valid.content),
      ]);
      if (!t) throw new Error("Template not found.");
      await audit(tx, ctx, "template.saved", "template", id, `Saved draft of "${name}"`);
      if (fd.get("publish") === "1") {
        const { version } = await publishTemplate(tx, id, auth.user.id, optional(fd, "changeNote") ?? undefined);
        await audit(tx, ctx, "template.published", "template", id, `Published "${name}" v${version}`);
      }
    });
    revalidatePath(`/app/templates/${id}`);
    revalidatePath(`/app/templates`);
    return { ok: fd.get("publish") === "1" ? "Published. New onboardings will use this version; existing ones keep theirs." : "Draft saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function archiveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    assertCanEditTemplates(auth);
    const ctx = tenantCtx(auth);
    const archived = str(fd, "archived") === "true";
    await withTenant(ctx, async (tx) => {
      await tx.q("update templates set archived = $2 where id = $1", [str(fd, "templateId"), archived]);
      await audit(tx, ctx, archived ? "template.archived" : "template.restored", "template", str(fd, "templateId"), archived ? "Archived template" : "Restored template");
    });
    revalidatePath("/app/templates");
    return { ok: archived ? "Archived." : "Restored." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Settings (admin)
// ---------------------------------------------------------------------------

export async function updateWorkspaceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const color = str(fd, "brandColor");
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { error: "Brand color must be a hex value like #7647e8." };
    const tz = str(fd, "timezone");
    if (!isValidTimeZone(tz)) return { error: "Choose a valid time zone." };
    const logo = optional(fd, "logoUrl");
    if (logo && !/^https:\/\//.test(logo)) return { error: "Logo URL must start with https://" };
    const maxMb = Number(str(fd, "maxUploadMb"));
    if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 100) return { error: "Upload limit must be between 1 and 100 MB." };
    await withTenant(ctx, async (tx) => {
      await tx.q(
        "update workspaces set name = $2, brand_color = $3, logo_url = $4, portal_welcome = $5, timezone = $6, email_from_name = $7, max_upload_mb = $8 where id = $1",
        [auth.workspace.id, str(fd, "name") || auth.workspace.name, color, logo, str(fd, "portalWelcome").slice(0, 600), tz, optional(fd, "emailFromName"), maxMb],
      );
      await audit(tx, ctx, "workspace.updated", null, null, "Updated workspace settings and branding");
    });
    revalidatePath("/", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function updatePolicyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const retention = str(fd, "retentionDays");
    const retentionDays = retention ? Number(retention) : null;
    if (retentionDays != null && (!Number.isInteger(retentionDays) || retentionDays < 30)) return { error: "Retention must be at least 30 days, or blank to keep files." };
    const editRole = str(fd, "templateEditRole") === "staff" ? "staff" : "admin";
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set template_edit_role = $2, retention_days = $3 where id = $1", [auth.workspace.id, editRole, retentionDays]);
      await audit(tx, ctx, "workspace.policy", null, null, `Template editing: ${editRole}s; file retention: ${retentionDays ? retentionDays + " days after completion" : "keep"}`);
    });
    revalidatePath("/app/settings", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function updateAiSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const enabled = fd.get("aiEnabled") === "on";
    const docs = fd.get("aiProcessDocuments") === "on";
    if (docs && fd.get("acknowledge") !== "on") return { error: "Confirm that you understand which document data is sent before enabling it." };
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set ai_enabled = $2, ai_process_documents = $3 where id = $1", [auth.workspace.id, enabled, enabled && docs]);
      await audit(tx, ctx, "workspace.ai", null, null, `AI assistance ${enabled ? "on" : "off"}; document processing ${enabled && docs ? "on" : "off"}`);
    });
    revalidatePath("/app/settings", "layout");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function inviteStaffAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const role = str(fd, "role") === "admin" ? "admin" : "staff";
    const email = str(fd, "email");
    const data = await withTenant(ctx, async (tx) => {
      const invite = await createInvitation(tx, ctx, { email, role });
      const sent = await sendInvitationEmail(tx, workspaceOf(auth), invite, email, role);
      return { inviteUrl: invite.url, emailStatus: sent?.status };
    });
    revalidatePath("/app/settings/team");
    return { ok: `Invitation created for ${email}.`, data };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeInvitationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ email: string }>("update invitations set revoked_at = now() where id = $1 and accepted_at is null returning email", [str(fd, "invitationId")]);
      if (!row) throw new Error("Invitation not found.");
      await audit(tx, ctx, "invitation.revoked", "invitation", str(fd, "invitationId"), `Revoked invitation for ${row.email}`);
    });
    revalidatePath("/app", "layout");
    return { ok: "Invitation revoked." };
  } catch (e) {
    return fail(e);
  }
}

export async function updateMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const memberId = str(fd, "memberId");
    const role = str(fd, "role") === "admin" ? "admin" : "staff";
    await withTenant(ctx, async (tx) => {
      const m = await tx.one<{ user_id: string; role: string }>("select user_id, role from memberships where id = $1", [memberId]);
      if (!m || m.role === "client") throw new Error("Member not found.");
      if (m.user_id === auth.user.id && role !== "admin") throw new Error("You can't remove your own admin role.");
      await tx.q("update memberships set role = $2, can_approve = $3 where id = $1", [memberId, role, role === "admin" || fd.get("canApprove") === "on"]);
      await audit(tx, ctx, "member.updated", "membership", memberId, `Changed a team member's role to ${role}${fd.get("canApprove") === "on" ? " with completion approval" : ""}`);
    });
    revalidatePath("/app/settings/team");
    return { ok: "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function removeMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("staff");
    const ctx = tenantCtx(auth);
    const memberId = str(fd, "memberId");
    const userId = await withTenant(ctx, async (tx) => {
      const m = await tx.one<{ user_id: string; role: string; email: string }>(
        "select m.user_id, m.role, u.email from memberships m join users u on u.id = m.user_id where m.id = $1",
        [memberId],
      );
      if (!m) throw new Error("Member not found.");
      if (m.role !== "client" && auth.role !== "admin") throw new Error("Only admins can remove team members.");
      if (m.role === "client" && auth.role !== "admin") throw new Error("Only admins can remove client contacts.");
      if (m.user_id === auth.user.id) throw new Error("You can't remove yourself.");
      await tx.q("delete from memberships where id = $1", [memberId]);
      await audit(tx, ctx, "member.removed", "membership", memberId, `Removed ${m.email} (${m.role}) and signed them out`);
      return m.user_id;
    });
    await revokeAllSessionsForUser(userId);
    revalidatePath("/app", "layout");
    return { ok: "Removed and signed out." };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeMemberSessionsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const userId = await withTenant(ctx, async (tx) => {
      const m = await tx.one<{ user_id: string; email: string }>(
        "select m.user_id, u.email from memberships m join users u on u.id = m.user_id where m.id = $1",
        [str(fd, "memberId")],
      );
      if (!m) throw new Error("Member not found.");
      await audit(tx, ctx, "sessions.revoked", "membership", str(fd, "memberId"), `Signed ${m.email} out of all devices`);
      return m.user_id;
    });
    await revokeAllSessionsForUser(userId, userId === auth.user.id ? auth.sessionId : undefined);
    return { ok: "All their sessions were revoked." };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeMySessionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth();
    const id = str(fd, "sessionId");
    if (id === "others") await revokeAllSessionsForUser(auth.user.id, auth.sessionId);
    else await revokeSession(id, auth.user.id);
    revalidatePath("/app/settings/security");
    return { ok: "Signed out." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Reminder rules
// ---------------------------------------------------------------------------

function parseRule(fd: FormData) {
  const trigger = str(fd, "trigger");
  if (!["before_due", "overdue", "no_activity"].includes(trigger)) throw new Error("Choose when the reminder is sent.");
  const offset = Number(str(fd, "offsetDays") || 0);
  const repeat = str(fd, "repeatEveryDays") ? Number(str(fd, "repeatEveryDays")) : null;
  const hour = Number(str(fd, "sendHour") || 9);
  if (!Number.isInteger(offset) || offset < 0 || offset > 60) throw new Error("Days must be between 0 and 60.");
  if (repeat != null && (!Number.isInteger(repeat) || repeat < 1 || repeat > 30)) throw new Error("Repeat must be between 1 and 30 days.");
  if (!Number.isInteger(hour) || hour < 0 || hour > 19) throw new Error("Send hour must be between 0 and 19 (reminders never go out after 8pm local time).");
  const name = str(fd, "name");
  const subject = str(fd, "subject");
  const body = str(fd, "body");
  if (!name || !subject || !body) throw new Error("Name, subject and message are required.");
  if (!body.includes("{{item_list}}")) throw new Error("The message must include {{item_list}} so clients see what's outstanding.");
  return { name, trigger, offset, repeat: trigger === "before_due" ? null : repeat, hour, subject, body };
}

export async function saveRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const r = parseRule(fd);
    const id = optional(fd, "ruleId");
    await withTenant(ctx, async (tx) => {
      if (id) {
        // Any edit disables the rule and requires a fresh preview before re-enabling.
        await tx.q(
          `update reminder_rules set name=$2, trigger=$3, offset_days=$4, repeat_every_days=$5, send_hour=$6, subject=$7, body=$8,
             enabled=false, previewed_at=null where id=$1`,
          [id, r.name, r.trigger, r.offset, r.repeat, r.hour, r.subject, r.body],
        );
        await audit(tx, ctx, "reminder_rule.updated", "reminder_rule", id, `Edited reminder "${r.name}" (disabled until previewed)`);
      } else {
        const row = await tx.one<{ id: string }>(
          `insert into reminder_rules (workspace_id, name, trigger, offset_days, repeat_every_days, send_hour, subject, body)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [auth.workspace.id, r.name, r.trigger, r.offset, r.repeat, r.hour, r.subject, r.body],
        );
        await audit(tx, ctx, "reminder_rule.created", "reminder_rule", row!.id, `Created reminder "${r.name}"`);
      }
    });
    revalidatePath("/app/settings/reminders");
    return { ok: id ? "Saved. Preview it again before enabling." : "Created. Preview it, then enable it." };
  } catch (e) {
    return fail(e);
  }
}

export async function previewRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const ruleId = str(fd, "ruleId");
    const data = await withTenant(ctx, async (tx) => {
      const rule = await tx.one<ReminderRule>("select * from reminder_rules where id = $1", [ruleId]);
      if (!rule) throw new Error("Reminder not found.");
      const sample = await tx.one<{ client_name: string; timezone: string; contact: string | null; onboarding_id: string }>(
        `select c.name as client_name, c.timezone, c.primary_contact_name as contact, o.id as onboarding_id
         from onboardings o join clients c on c.id = o.client_id where o.status = 'active'
         order by (select count(*) from onboarding_items i where i.onboarding_id = o.id and i.status in ('not_started','in_progress','changes_requested') and i.audience = 'client') desc limit 1`,
      );
      const items = sample
        ? await tx.q<{ id: string; title: string; due_at: Date | null; status: string; updated_at: Date }>(
            `select id, title, due_at, status, updated_at from onboarding_items where onboarding_id = $1 and audience = 'client'
             and status in ('not_started','in_progress','changes_requested') order by due_at nulls last limit 5`,
            [sample.onboarding_id],
          )
        : [{ id: "x", title: "Company profile", due_at: new Date(Date.now() + 2 * 86400000), status: "not_started", updated_at: new Date() }];
      const rendered = renderReminder(rule, {
        contactName: sample?.contact?.split(" ")[0] ?? "Alex",
        clientName: sample?.client_name ?? "Example Client",
        workspaceName: auth.workspace.name,
        items,
        timeZone: sample?.timezone ?? auth.workspace.timezone,
      });
      await tx.q("update reminder_rules set previewed_at = now() where id = $1", [ruleId]);
      return { ...rendered, sampleClient: sample?.client_name ?? "a sample client", timeZone: sample?.timezone ?? auth.workspace.timezone };
    });
    revalidatePath("/app/settings/reminders");
    return { ok: "", data };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    const enable = str(fd, "enabled") === "true";
    await withTenant(ctx, async (tx) => {
      const rule = await tx.one<{ name: string; previewed_at: Date | null }>("select name, previewed_at from reminder_rules where id = $1", [str(fd, "ruleId")]);
      if (!rule) throw new Error("Reminder not found.");
      if (enable && !rule.previewed_at) throw new Error("Preview this reminder before enabling it.");
      await tx.q("update reminder_rules set enabled = $2 where id = $1", [str(fd, "ruleId"), enable]);
      await audit(tx, ctx, enable ? "reminder_rule.enabled" : "reminder_rule.disabled", "reminder_rule", str(fd, "ruleId"), `${enable ? "Enabled" : "Disabled"} reminder "${rule.name}"`);
    });
    revalidatePath("/app/settings/reminders");
    return { ok: enable ? "Enabled." : "Disabled." };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ name: string }>("delete from reminder_rules where id = $1 returning name", [str(fd, "ruleId")]);
      if (row) await audit(tx, ctx, "reminder_rule.deleted", "reminder_rule", null, `Deleted reminder "${row.name}"`);
    });
    revalidatePath("/app/settings/reminders");
    return { ok: "Deleted." };
  } catch (e) {
    return fail(e);
  }
}

export async function runRemindersNowAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const s = await runReminders({ workspaceId: auth.workspace.id });
    await withTenant(tenantCtx(auth), (tx) =>
      audit(tx, tenantCtx(auth), "reminders.run", null, null, `Ran reminders manually: ${s.sent} sent, ${s.simulated} simulated, ${s.failed} failed, ${s.duplicatesPrevented} duplicates prevented`),
    );
    revalidatePath("/app/settings", "layout");
    return {
      ok: `Done: ${s.sent} sent, ${s.simulated} recorded in demo outbox, ${s.failed} failed, ${s.duplicatesPrevented} duplicate${s.duplicatesPrevented === 1 ? "" : "s"} skipped. Only clients whose local time is between each rule's send hour and 8pm are included.`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function runRetentionNowAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const r = await runRetention({ workspaceId: auth.workspace.id });
    revalidatePath("/app/settings", "layout");
    return { ok: `Retention run complete: ${r.purged} file${r.purged === 1 ? "" : "s"} removed.` };
  } catch (e) {
    return fail(e);
  }
}
