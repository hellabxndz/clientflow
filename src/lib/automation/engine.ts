import { sysQuery, withTenant, type TenantContext, type Tx } from "../db";
import { audit } from "../audit";
import { env } from "../env";
import { sendEmail } from "../email";
import { notify, resolveRecipients, type Recipient } from "../notifications";
import { computeOnboardingState, isAwaitingReview, type ItemLike, type OnboardingLike } from "../onboarding";
import { createOnboardingFromTemplate } from "../templates";
import { createInvitation, sendInvitationEmail } from "../invitations";
import { runHandoff } from "../integrations/handoff";
import { postChatMessage } from "../integrations/chat";
import { triggersForEvent, type AutomationAction, type Condition, type TriggerType } from "./catalog";

export interface WorkspaceInfo {
  id: string;
  name: string;
  is_demo: boolean;
  email_from_name: string | null;
}

export interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  category: "automation" | "escalation" | "handoff";
  trigger: TriggerType;
  trigger_config: { days?: number; hours?: number; itemKey?: string };
  conditions: Condition[];
  condition_mode: "all" | "any";
  actions: AutomationAction[];
  run_mode: "once_per_onboarding" | "every_event";
  template_id: string | null;
  enabled: boolean;
}

export interface EventRow {
  id: string | null;
  workspace_id: string;
  type: string;
  client_id: string | null;
  onboarding_id: string | null;
  item_id: string | null;
  payload: Record<string, unknown>;
  created_at?: Date;
}

interface ClientRow {
  id: string;
  name: string;
  owner_user_id: string | null;
  client_type_id: string | null;
  deal_amount: string | null;
  primary_contact_email: string | null;
  primary_contact_name: string | null;
  archived_at: Date | null;
}

interface OnboardingRow extends OnboardingLike {
  id: string;
  name: string;
  client_id: string;
  template_id: string | null;
  kickoff_ready_at: Date | null;
}

type Item = ItemLike & { section_key: string; category: string | null };

interface RunContext {
  tx: Tx;
  ws: WorkspaceInfo;
  rule: RuleRow;
  event: EventRow;
  runId: string;
  client: ClientRow | null;
  onboarding: OnboardingRow | null;
  items: Item[];
  item: Item | null;
}

export interface ActionResult {
  type: string;
  status: "done" | "skipped" | "failed";
  detail: string;
}

export const systemCtx = (workspaceId: string): TenantContext => ({ workspaceId, userId: null, role: "system" });

// ---------------------------------------------------------------------------
// Context and conditions
// ---------------------------------------------------------------------------

async function loadContext(tx: Tx, event: EventRow) {
  const onboarding = event.onboarding_id
    ? await tx.one<OnboardingRow>("select * from onboardings where id = $1", [event.onboarding_id])
    : event.client_id
      ? await tx.one<OnboardingRow>(
          "select * from onboardings where client_id = $1 and status in ('active', 'paused') order by created_at desc limit 1",
          [event.client_id],
        )
      : null;
  const clientId = event.client_id ?? onboarding?.client_id ?? null;
  const client = clientId ? await tx.one<ClientRow>("select * from clients where id = $1", [clientId]) : null;
  const items = onboarding
    ? await tx.q<Item>("select * from onboarding_items where onboarding_id = $1 and removed_at is null order by position", [onboarding.id])
    : [];
  const item = event.item_id
    ? items.find((i) => i.id === event.item_id) ?? (await tx.one<Item>("select * from onboarding_items where id = $1", [event.item_id]))
    : null;
  return { client, onboarding, items, item };
}

export function evaluateConditions(
  rule: Pick<RuleRow, "conditions" | "condition_mode">,
  c: { client: ClientRow | null; onboarding: OnboardingRow | null; items: Item[]; item: Item | null },
) {
  if (!rule.conditions.length) return true;
  const state = c.onboarding ? computeOnboardingState(c.onboarding, c.items) : null;
  const check = (cond: Condition): boolean => {
    switch (cond.type) {
      case "item_status": {
        const it = c.items.find((i) => i.item_key === cond.itemKey);
        if (!it) return false;
        if (cond.state === "approved") return it.status === "approved";
        if (cond.state === "submitted") return it.status === "approved" || isAwaitingReview(it.status);
        return it.status !== "approved";
      }
      case "section_complete": {
        const req = c.items.filter((i) => i.section_key === cond.sectionKey && i.required);
        return req.length > 0 && req.every((i) => i.status === "approved");
      }
      case "all_required_approved":
        return !!state?.readyForCompletion;
      case "critical_complete": {
        const crit = c.items.filter((i) => i.critical);
        return crit.length > 0 && crit.every((i) => i.status === "approved");
      }
      case "readiness_at_least":
        return (state?.readiness.score ?? -1) >= cond.percent;
      case "client_type_is":
        return c.client?.client_type_id === cond.clientTypeId;
      case "deal_value_at_least":
        return Number(c.client?.deal_amount ?? 0) >= cond.amount;
      case "not_ready_for_kickoff":
        return !!c.onboarding && !c.onboarding.kickoff_ready_at;
      case "event_item_is":
        return c.item?.item_key === cond.itemKey;
      case "event_item_category_is":
        return c.item?.category === cond.category;
      case "onboarding_has_no_owner":
        return !!c.onboarding && !c.onboarding.owner_user_id;
    }
  };
  return rule.condition_mode === "any" ? rule.conditions.some(check) : rule.conditions.every(check);
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

async function render(ctx: RunContext, text: string) {
  const owner = ctx.onboarding?.owner_user_id
    ? await ctx.tx.one<{ name: string }>("select name from users where id = $1", [ctx.onboarding.owner_user_id])
    : null;
  const state = ctx.onboarding ? computeOnboardingState(ctx.onboarding, ctx.items) : null;
  const outstanding = ctx.items
    .filter((i) => i.audience === "client" && i.required && !["approved", "submitted", "under_review"].includes(i.status))
    .map((i) => `• ${i.title}`)
    .join("\n");
  return text
    .replaceAll("{{client_name}}", ctx.client?.name ?? "the client")
    .replaceAll("{{onboarding_name}}", ctx.onboarding?.name ?? "onboarding")
    .replaceAll("{{item_title}}", ctx.item?.title ?? "")
    .replaceAll("{{readiness}}", state?.readiness.score != null ? `${state.readiness.score}%` : "n/a")
    .replaceAll("{{owner_name}}", owner?.name ?? "the team")
    .replaceAll("{{outstanding_items}}", outstanding || "• Nothing outstanding")
    .replaceAll("{{portal_link}}", `${env.appUrl}/portal`)
    .replaceAll("{{workspace_name}}", ctx.ws.name);
}

const clientLink = (ctx: RunContext) => (ctx.client ? `/app/clients/${ctx.client.id}` : "/app");

function dueIn(days: number | null | undefined) {
  if (days == null) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(17, 0, 0, 0);
  return d.toISOString();
}

async function resolveAssignee(ctx: RunContext, a: "onboarding_owner" | "account_manager" | { userId: string }) {
  const ids = await resolveRecipients(ctx.tx, a as Recipient, { onboardingId: ctx.onboarding?.id, clientId: ctx.client?.id });
  return ids[0] ?? null;
}

async function addItem(
  ctx: RunContext,
  input: { section: [string, string]; kind: string; title: string; description?: string | null; audience: "client" | "internal"; required: boolean; due: string | null; owner: string | null; config?: unknown; category?: string | null },
) {
  const onb = ctx.onboarding!;
  const [{ pos }] = await ctx.tx.q<{ pos: number }>("select coalesce(max(position), 0) + 1 as pos from onboarding_items where onboarding_id = $1", [onb.id]);
  const key = `auto_${ctx.runId.slice(0, 8)}_${pos}`;
  const row = await ctx.tx.one<{ id: string }>(
    `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key, position, kind, title,
       description, audience, required, due_at, owner_user_id, config, category)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.ws.id, onb.client_id, onb.id, input.section[0], input.section[1], key, pos, input.kind, input.title, input.description ?? null,
     input.audience, input.required, input.due, input.owner, JSON.stringify(input.config ?? {}), input.category ?? null],
  );
  return row!.id;
}

async function clientRecipients(ctx: RunContext) {
  if (!ctx.client) return [];
  const rows = await ctx.tx.q<{ email: string; name: string }>(
    `select u.email, u.name from memberships m join users u on u.id = m.user_id where m.role = 'client' and m.client_id = $1`,
    [ctx.client.id],
  );
  if (rows.length === 0 && ctx.client.primary_contact_email)
    rows.push({ email: ctx.client.primary_contact_email, name: ctx.client.primary_contact_name ?? "there" });
  return rows;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function runAction(ctx: RunContext, action: AutomationAction): Promise<Omit<ActionResult, "type">> {
  const { tx } = ctx;
  const needOnboarding = () => {
    if (!ctx.onboarding) throw new Skip("No onboarding for this client yet");
    return ctx.onboarding;
  };
  switch (action.type) {
    case "create_onboarding":
    case "assign_template": {
      if (!ctx.client) throw new Skip("No client on this event");
      if (ctx.client.archived_at) throw new Skip("Client is archived");
      const existing = await tx.one("select 1 from onboardings where client_id = $1 and status in ('active', 'paused')", [ctx.client.id]);
      if (existing) throw new Skip("Client already has an onboarding in progress");
      let templateId = action.templateId ?? null;
      const type = ctx.client.client_type_id
        ? await tx.one<{ template_id: string | null; default_owner_user_id: string | null; name: string }>(
            "select template_id, default_owner_user_id, name from client_types where id = $1",
            [ctx.client.client_type_id],
          )
        : null;
      if (!templateId) templateId = type?.template_id ?? null;
      if (!templateId) throw new Skip(ctx.client.client_type_id ? `No workflow is mapped to the "${type?.name}" client type` : "Client has no client type, so no workflow could be chosen");
      const owner = ctx.client.owner_user_id ?? type?.default_owner_user_id ?? null;
      const { onboardingId, templateVersion } = await createOnboardingFromTemplate(tx, {
        workspaceId: ctx.ws.id,
        clientId: ctx.client.id,
        templateId,
        ownerUserId: owner,
        source: ctx.event.type === "deal_imported" ? "crm" : "automation",
      });
      const fresh = await loadContext(tx, { ...ctx.event, onboarding_id: onboardingId, client_id: ctx.client.id });
      Object.assign(ctx, { onboarding: fresh.onboarding, items: fresh.items });
      const tpl = await tx.one<{ name: string }>("select name from templates where id = $1", [templateId]);
      await audit(tx, systemCtx(ctx.ws.id), "onboarding.created", "onboarding", onboardingId, `Automation started "${tpl?.name}" (v${templateVersion})`);
      return { status: "done", detail: `Started "${tpl?.name}" v${templateVersion}` };
    }
    case "assign_owner": {
      const onb = needOnboarding();
      let owner: string | null = null;
      if (action.owner === "client_type_default") {
        const t = ctx.client?.client_type_id
          ? await tx.one<{ default_owner_user_id: string | null }>("select default_owner_user_id from client_types where id = $1", [ctx.client.client_type_id])
          : null;
        owner = t?.default_owner_user_id ?? null;
      } else if (action.owner === "account_manager") owner = ctx.client?.owner_user_id ?? null;
      else owner = (await resolveRecipients(tx, action.owner, {}))[0] ?? null;
      if (!owner) throw new Skip("No owner could be resolved");
      await tx.q("update onboardings set owner_user_id = $2 where id = $1", [onb.id, owner]);
      await tx.q("update clients set owner_user_id = coalesce(owner_user_id, $2) where id = $1", [onb.client_id, owner]);
      await tx.q("update onboarding_items set owner_user_id = $2 where onboarding_id = $1 and audience = 'internal' and owner_user_id is null", [onb.id, owner]);
      onb.owner_user_id = owner;
      const u = await tx.one<{ name: string }>("select name from users where id = $1", [owner]);
      return { status: "done", detail: `Assigned to ${u?.name}` };
    }
    case "create_task": {
      needOnboarding();
      const owner = await resolveAssignee(ctx, action.assignee);
      const title = await render(ctx, action.title);
      await addItem(ctx, { section: ["team_tasks", "Team tasks"], kind: "task", title, audience: "internal", required: action.required ?? false, due: dueIn(action.dueInDays), owner });
      return { status: "done", detail: `Created task "${title}"` };
    }
    case "request_information": {
      needOnboarding();
      const q = await render(ctx, action.question);
      await addItem(ctx, {
        section: ["questions", "Questions from the team"],
        kind: "question",
        title: q.slice(0, 200),
        description: q.length > 200 ? q : null,
        audience: "client",
        required: true,
        due: dueIn(action.dueInDays),
        owner: ctx.onboarding!.owner_user_id,
      });
      return { status: "done", detail: "Added a question to the client's checklist" };
    }
    case "request_document": {
      needOnboarding();
      await addItem(ctx, {
        section: ["additional_documents", "Additional documents"],
        kind: "file",
        title: action.title,
        description: action.description ?? null,
        audience: "client",
        required: true,
        due: dueIn(action.dueInDays),
        owner: ctx.onboarding!.owner_user_id,
        config: { file: { accept: action.accept, maxSizeMb: 25 } },
        category: action.category ?? null,
      });
      return { status: "done", detail: `Requested "${action.title}"` };
    }
    case "send_email": {
      const subject = await render(ctx, action.subject);
      const body = await render(ctx, action.body);
      const to =
        action.to === "client_contacts"
          ? (await clientRecipients(ctx)).map((r) => r.email)
          : await Promise.all(
              (await resolveRecipients(tx, action.to, { onboardingId: ctx.onboarding?.id, clientId: ctx.client?.id })).map(
                async (id) => (await tx.one<{ email: string }>("select email from users where id = $1", [id]))!.email,
              ),
            );
      if (to.length === 0) throw new Skip("No recipients");
      const statuses: string[] = [];
      for (const email of to) {
        const r = await sendEmail(tx, ctx.ws, {
          workspaceId: ctx.ws.id,
          kind: "automation",
          to: email,
          subject,
          body,
          onboardingId: ctx.onboarding?.id ?? null,
          dedupeKey: `auto:${ctx.runId}:${email}`,
          automationRunId: ctx.runId,
        });
        statuses.push(r?.status ?? "duplicate");
      }
      return { status: statuses.includes("failed") ? "failed" : "done", detail: `Email to ${to.length} recipient${to.length === 1 ? "" : "s"}: ${[...new Set(statuses)].join(", ")}` };
    }
    case "schedule_reminder": {
      const onb = needOnboarding();
      const recipients = await clientRecipients(ctx);
      if (recipients.length === 0) throw new Skip("Client has no contact email");
      const outstanding = ctx.items.filter((i) => i.audience === "client" && i.required && ["not_started", "in_progress", "changes_requested"].includes(i.status));
      if (outstanding.length === 0) throw new Skip("Nothing outstanding to remind about");
      const sendAfter = new Date(Date.now() + action.afterDays * 86400000);
      for (const r of recipients)
        await tx.q(
          `insert into email_messages (workspace_id, kind, onboarding_id, item_ids, dedupe_key, to_email, subject, body, status, send_after, automation_run_id)
           values ($1, 'reminder', $2, $3, $4, $5, $6, $7, 'scheduled', $8, $9) on conflict (dedupe_key) do nothing`,
          [ctx.ws.id, onb.id, outstanding.map((i) => i.id), `sched:${ctx.runId}:${r.email}`, r.email, action.subject, action.body, sendAfter, ctx.runId],
        );
      return { status: "done", detail: `Reminder scheduled for ${sendAfter.toDateString()} (cancelled automatically if the items are completed)` };
    }
    case "invite_client": {
      if (!ctx.client) throw new Skip("No client on this event");
      const email = ctx.client.primary_contact_email;
      if (!email) throw new Skip("Client has no primary contact email");
      const member = await tx.one("select 1 from memberships m join users u on u.id = m.user_id where m.client_id = $1", [ctx.client.id]);
      if (member) throw new Skip("Client already has portal access");
      const pending = await tx.one("select 1 from invitations where client_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()", [ctx.client.id]);
      if (pending) throw new Skip("An invitation is already pending");
      const invite = await createInvitation(tx, systemCtx(ctx.ws.id), { email, role: "client", clientId: ctx.client.id });
      const sent = await sendInvitationEmail(tx, ctx.ws, invite, email, "client", ctx.client.name);
      return { status: sent?.status === "failed" ? "failed" : "done", detail: `Invitation to ${email} (${sent?.status ?? "recorded"})` };
    }
    case "notify_staff": {
      const ids = await resolveRecipients(tx, action.to, { onboardingId: ctx.onboarding?.id, clientId: ctx.client?.id, itemId: ctx.item?.id });
      if (ids.length === 0) throw new Skip("Nobody to notify (no owner assigned)");
      const message = await render(ctx, action.message);
      await notify(tx, {
        workspace: ctx.ws,
        userIds: ids,
        title: message.split("\n")[0].slice(0, 200),
        body: message,
        link: clientLink(ctx),
        onboardingId: ctx.onboarding?.id,
        kind: ctx.rule.category,
        dedupeKey: `run:${ctx.runId}`,
        email: action.email ?? false,
      });
      const names = await tx.q<{ name: string }>("select name from users where id = any($1)", [ids]);
      return { status: "done", detail: `Notified ${names.map((n) => n.name).join(", ")}` };
    }
    case "update_stage": {
      const onb = needOnboarding();
      if (action.stage === "at_risk") {
        if (onb.at_risk) throw new Skip("Already flagged At Risk");
        await tx.q("update onboardings set at_risk = true, at_risk_reason = $2, at_risk_at = now() where id = $1", [onb.id, action.reason ?? ctx.rule.name]);
        return { status: "done", detail: "Flagged At Risk" };
      }
      if (action.stage === "clear_at_risk") {
        if (!onb.at_risk) throw new Skip("Not flagged At Risk");
        await tx.q("update onboardings set at_risk = false, at_risk_reason = null, at_risk_at = null where id = $1", [onb.id]);
        return { status: "done", detail: "Cleared At Risk" };
      }
      if (action.stage === "pause") {
        if (onb.status !== "active") throw new Skip("Onboarding isn't active");
        await tx.q("update onboardings set status = 'paused', paused_at = now() where id = $1", [onb.id]);
        return { status: "done", detail: "Paused (reminders stop)" };
      }
      if (onb.status !== "paused") throw new Skip("Onboarding isn't paused");
      await tx.q("update onboardings set status = 'active' where id = $1", [onb.id]);
      return { status: "done", detail: "Resumed" };
    }
    case "add_note": {
      const onb = needOnboarding();
      const body = await render(ctx, action.body);
      await tx.q(
        `insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body, source)
         values ($1,$2,$3,$4,null,'internal',$5,'automation')`,
        [ctx.ws.id, onb.client_id, onb.id, ctx.item?.id ?? null, `${body}\n\n(Added by automation "${ctx.rule.name}")`],
      );
      return { status: "done", detail: "Internal note added" };
    }
    case "create_review_task": {
      needOnboarding();
      if (!ctx.item) throw new Skip("No item on this event");
      const reviewer = await resolveAssignee(ctx, action.reviewer);
      if (reviewer) await tx.q("update onboarding_items set reviewer_user_id = $2 where id = $1 and reviewer_user_id is null", [ctx.item.id, reviewer]);
      await addItem(ctx, {
        section: ["team_tasks", "Team tasks"],
        kind: "task",
        title: `Review "${ctx.item.title}"`,
        audience: "internal",
        required: false,
        due: dueIn(1),
        owner: reviewer,
      });
      return { status: "done", detail: `Review task created${reviewer ? "" : " (no reviewer resolved)"}` };
    }
    case "mark_ready_for_kickoff": {
      const onb = needOnboarding();
      if (onb.status !== "active") throw new Skip("Onboarding isn't active");
      if (onb.kickoff_ready_at) throw new Skip("Already Ready for Kickoff");
      await tx.q("update onboardings set kickoff_ready_at = now(), at_risk = false, at_risk_reason = null where id = $1", [onb.id]);
      onb.kickoff_ready_at = new Date();
      await audit(tx, systemCtx(ctx.ws.id), "onboarding.ready_for_kickoff", "onboarding", onb.id, "Marked Ready for Kickoff by automation", { rule: ctx.rule.name });
      return { status: "done", detail: "Marked Ready for Kickoff" };
    }
    case "trigger_integration": {
      const onb = needOnboarding();
      const r = await runHandoff(tx, ctx.ws, action.provider, {
        name: await render(ctx, action.name ?? "{{client_name}} – onboarding handoff"),
        clientName: ctx.client?.name ?? "",
        onboardingId: onb.id,
        clientId: onb.client_id,
        summary: await render(ctx, "Onboarding for {{client_name}} is ready for kickoff ({{readiness}} ready).\nOwner: {{owner_name}}"),
        link: `${env.appUrl}${clientLink(ctx)}`,
      });
      if (r.status === "done") await tx.q("update onboardings set handed_off_at = now() where id = $1", [onb.id]);
      return r;
    }
    case "chat_notification": {
      return postChatMessage(tx, ctx.ws, action.provider, await render(ctx, action.message), {
        clientId: ctx.client?.id ?? null,
        onboardingId: ctx.onboarding?.id ?? null,
      });
    }
  }
}

class Skip extends Error {}

// ---------------------------------------------------------------------------
// Running rules
// ---------------------------------------------------------------------------

/**
 * Runs a rule once for a dedupe key. The unique (rule_id, dedupe_key) constraint on
 * automation_runs makes execution idempotent: a second attempt with the same key is a no-op.
 */
export async function executeRule(tx: Tx, ws: WorkspaceInfo, rule: RuleRow, event: EventRow, dedupeKey: string) {
  const loaded = await loadContext(tx, event);
  if (rule.template_id && loaded.onboarding?.template_id !== rule.template_id) return null;
  if (!evaluateConditions(rule, loaded)) return null;
  const claim = await tx.one<{ id: string }>(
    `insert into automation_runs (workspace_id, rule_id, event_id, client_id, onboarding_id, dedupe_key, trigger, status)
     values ($1,$2,$3,$4,$5,$6,$7,'skipped') on conflict (rule_id, dedupe_key) do nothing returning id`,
    [ws.id, rule.id, event.id, loaded.client?.id ?? null, loaded.onboarding?.id ?? null, dedupeKey, event.type],
  );
  if (!claim) return { duplicate: true as const };
  const ctx: RunContext = { tx, ws, rule, event, runId: claim.id, ...loaded };
  const results: ActionResult[] = [];
  for (const [i, action] of rule.actions.entries()) {
    const sp = `a${i}`;
    await tx.q(`savepoint ${sp}`);
    try {
      const r = await runAction(ctx, action);
      results.push({ type: action.type, ...r });
      await tx.q(`release savepoint ${sp}`);
    } catch (e) {
      await tx.q(`rollback to savepoint ${sp}`);
      results.push({
        type: action.type,
        status: e instanceof Skip ? "skipped" : "failed",
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      });
    }
  }
  const failed = results.filter((r) => r.status === "failed").length;
  const done = results.filter((r) => r.status === "done").length;
  const status = failed && done ? "partial" : failed ? "failed" : done ? "succeeded" : "skipped";
  await tx.q("update automation_runs set status = $2, results = $3, client_id = $4, onboarding_id = $5 where id = $1", [
    claim.id,
    status,
    JSON.stringify(results),
    ctx.client?.id ?? null,
    ctx.onboarding?.id ?? null,
  ]);
  if (done)
    await audit(tx, systemCtx(ws.id), "automation.executed", ctx.onboarding ? "onboarding" : "client", ctx.onboarding?.id ?? ctx.client?.id ?? null,
      `Automation "${rule.name}": ${results.filter((r) => r.status === "done").map((r) => r.detail).join("; ")}`.slice(0, 500),
      { ruleId: rule.id, runId: claim.id, status });
  return { runId: claim.id, status, results };
}

async function workspaceInfo(id: string) {
  const [ws] = await sysQuery<WorkspaceInfo>("select id, name, is_demo, email_from_name from workspaces where id = $1", [id]);
  return ws;
}

async function handleEvent(tx: Tx, ws: WorkspaceInfo, event: EventRow) {
  const triggers = triggersForEvent(event.type);
  if (triggers.length === 0) return 0;
  const rules = await tx.q<RuleRow>("select * from automation_rules where enabled and trigger = any($1) order by created_at", [triggers]);
  let runs = 0;
  for (const rule of rules) {
    const itemKey = rule.trigger_config?.itemKey;
    if (itemKey && event.payload?.itemKey !== itemKey) continue;
    const scope = event.onboarding_id ?? event.client_id ?? event.id;
    const key = rule.run_mode === "once_per_onboarding" ? `scope:${scope}` : `event:${event.id}`;
    const r = await executeRule(tx, ws, rule, event, key);
    if (r && !("duplicate" in r)) runs++;
  }
  return runs;
}

/**
 * Processes queued domain events. Each event is handled in its own transaction while holding a
 * row lock, so concurrent workers never process the same event twice, and rule runs are
 * idempotent through their dedupe keys. Actions can emit new events, so this loops a few rounds.
 */
export async function processPendingEvents(opts: { workspaceId?: string; maxRounds?: number } = {}) {
  let processed = 0;
  let runs = 0;
  const cache = new Map<string, WorkspaceInfo>();
  for (let round = 0; round < (opts.maxRounds ?? 6); round++) {
    const pending = await sysQuery<EventRow & { attempts: number }>(
      `select id, workspace_id, type, client_id, onboarding_id, item_id, payload, created_at, attempts from automation_events
       where processed_at is null and attempts < 3 and ($1::uuid is null or workspace_id = $1) order by created_at limit 300`,
      [opts.workspaceId ?? null],
    );
    if (pending.length === 0) break;
    for (const ev of pending) {
      const ws = cache.get(ev.workspace_id) ?? (await workspaceInfo(ev.workspace_id));
      cache.set(ev.workspace_id, ws);
      try {
        runs += await withTenant(systemCtx(ws.id), async (tx) => {
          const locked = await tx.one("select id from automation_events where id = $1 and processed_at is null for update skip locked", [ev.id]);
          if (!locked) return 0;
          const n = await handleEvent(tx, ws, ev);
          await tx.q("update automation_events set processed_at = now(), attempts = attempts + 1, error = null where id = $1", [ev.id]);
          return n;
        });
        processed++;
      } catch (e) {
        await sysQuery(
          "update automation_events set attempts = attempts + 1, error = $2, processed_at = case when attempts + 1 >= 3 then now() else null end where id = $1",
          [ev.id, (e instanceof Error ? e.message : String(e)).slice(0, 500)],
        );
      }
    }
  }
  return { processed, runs };
}

/** Records an application-level event (for example a CRM deal) in the outbox. */
export async function emitEvent(tx: Tx, ev: Omit<EventRow, "id"> & { dedupeKey?: string | null; actorUserId?: string | null }) {
  const row = await tx.one<{ id: string }>(
    `insert into automation_events (workspace_id, type, client_id, onboarding_id, item_id, actor_user_id, payload, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (dedupe_key) do nothing returning id`,
    [ev.workspace_id, ev.type, ev.client_id, ev.onboarding_id, ev.item_id, ev.actorUserId ?? null, JSON.stringify(ev.payload ?? {}), ev.dedupeKey ?? null],
  );
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Time-based triggers (deadlines, inactivity, review waits) and escalations
// ---------------------------------------------------------------------------

export async function runTimeTriggers(opts: { now?: Date; workspaceId?: string } = {}) {
  const now = opts.now ?? new Date();
  const rules = await sysQuery<RuleRow>(
    `select * from automation_rules where enabled and trigger in ('deadline_approaching', 'deadline_overdue', 'client_inactive', 'review_waiting', 'task_overdue')
       and ($1::uuid is null or workspace_id = $1)`,
    [opts.workspaceId ?? null],
  );
  let runs = 0;
  for (const rule of rules) {
    const ws = await workspaceInfo(rule.workspace_id);
    runs += await withTenant(systemCtx(ws.id), async (tx) => {
      const days = rule.trigger_config?.days ?? 0;
      const hours = rule.trigger_config?.hours ?? 48;
      const itemKey = rule.trigger_config?.itemKey ?? null;
      let candidates: { item_id: string | null; onboarding_id: string; client_id: string; key: string }[] = [];
      const itemFilter = `i.removed_at is null and o.status = 'active' and ($2::text is null or i.item_key = $2)`;
      if (rule.trigger === "deadline_approaching")
        candidates = await tx.q(
          `select i.id as item_id, i.onboarding_id, i.client_id, 'item:' || i.id || ':' || i.due_at as key
           from onboarding_items i join onboardings o on o.id = i.onboarding_id
           where ${itemFilter} and i.required and i.status in ('not_started', 'in_progress', 'changes_requested')
             and i.due_at > $1 and i.due_at <= $1::timestamptz + ($3 || ' days')::interval`,
          [now, itemKey, String(days)],
        );
      else if (rule.trigger === "deadline_overdue" || rule.trigger === "task_overdue")
        candidates = await tx.q(
          `select i.id as item_id, i.onboarding_id, i.client_id, 'item:' || i.id || ':' || i.due_at as key
           from onboarding_items i join onboardings o on o.id = i.onboarding_id
           where ${itemFilter} and i.required and i.audience = $4 and i.status in ('not_started', 'in_progress', 'changes_requested')
             and i.due_at <= $1::timestamptz - ($3 || ' days')::interval`,
          [now, itemKey, String(days), rule.trigger === "task_overdue" ? "internal" : "client"],
        );
      else if (rule.trigger === "review_waiting")
        candidates = await tx.q(
          `select i.id as item_id, i.onboarding_id, i.client_id, 'item:' || i.id || ':' || i.status_changed_at as key
           from onboarding_items i join onboardings o on o.id = i.onboarding_id
           where ${itemFilter} and i.status in ('submitted', 'under_review') and i.status_changed_at <= $1::timestamptz - ($3 || ' hours')::interval`,
          [now, itemKey, String(hours)],
        );
      else if (rule.trigger === "client_inactive")
        candidates = await tx.q(
          `select null as item_id, o.id as onboarding_id, o.client_id,
                  'onb:' || o.id || ':' || coalesce(o.last_client_activity_at, o.created_at) as key
           from onboardings o
           where o.status = 'active' and coalesce(o.last_client_activity_at, o.created_at) <= $1::timestamptz - ($2 || ' days')::interval
             and exists (select 1 from onboarding_items i where i.onboarding_id = o.id and i.audience = 'client' and i.required
                         and i.removed_at is null and i.status in ('not_started', 'in_progress', 'changes_requested'))`,
          [now, String(days)],
        );
      let n = 0;
      for (const c of candidates) {
        const r = await executeRule(
          tx,
          ws,
          rule,
          { id: null, workspace_id: ws.id, type: rule.trigger, client_id: c.client_id, onboarding_id: c.onboarding_id, item_id: c.item_id, payload: {} },
          c.key,
        );
        if (r && !("duplicate" in r)) n++;
      }
      return n;
    });
  }
  return { runs };
}
