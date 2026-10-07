import { sysQuery, withTenant, type Tx } from "./db";
import { env } from "./env";
import { deliverRecorded, sendEmail } from "./email";
import { notify } from "./notifications";
import { dayDiff, localDate, localHour, localWeekday, formatDate } from "./time";

export interface ReminderRule {
  id: string;
  workspace_id: string;
  name: string;
  trigger: "before_due" | "overdue" | "no_activity";
  offset_days: number;
  repeat_every_days: number | null;
  send_hour: number;
  subject: string;
  body: string;
  enabled: boolean;
  previewed_at: Date | null;
  item_scope: ItemScope;
  template_id: string | null;
  notify_owner: boolean;
  business_days_only: boolean;
}

export type ItemScope = "all" | "form" | "file" | "access" | "question" | "checklist" | "signature";

export const TRIGGER_LABEL: Record<ReminderRule["trigger"], string> = {
  before_due: "Upcoming deadline",
  overdue: "Overdue item",
  no_activity: "Incomplete and inactive",
};

export const ITEM_SCOPE_LABEL: Record<ItemScope, string> = {
  all: "All incomplete client items",
  form: "Forms",
  file: "Missing documents",
  access: "Missing account access",
  question: "Unanswered staff questions",
  checklist: "Checklists",
  signature: "Signatures",
};

/** Client statuses that still need client action. Submitted, under-review and approved items never trigger reminders. */
export const REMINDABLE_STATUSES = ["not_started", "in_progress", "changes_requested"] as const;
const QUIET_HOUR = 20; // never send after 8pm in the client's time zone

export const PLACEHOLDERS = ["{{contact_name}}", "{{client_name}}", "{{workspace_name}}", "{{item_list}}", "{{portal_link}}", "{{account_manager}}"];

export const DEFAULT_REMINDER_BODY = `Hi {{contact_name}},

Your onboarding is almost complete.

We only need:

{{item_list}}

Once these are completed, your team can move forward with kickoff.

Thank you,
{{workspace_name}}

Open your portal: {{portal_link}}`;

export interface ReminderItem {
  id: string;
  title: string;
  due_at: Date | null;
  status: string;
  updated_at: Date;
  kind?: string;
}

export function renderReminder(
  rule: Pick<ReminderRule, "subject" | "body">,
  vars: { contactName: string; clientName: string; workspaceName: string; items: ReminderItem[]; timeZone: string; accountManager?: string | null },
) {
  const list = vars.items
    .map((i) => `• ${i.title}${i.due_at ? ` (due ${formatDate(i.due_at, vars.timeZone)})` : ""}${i.status === "changes_requested" ? " - changes requested" : ""}`)
    .join("\n");
  const replace = (s: string) =>
    s
      .replaceAll("{{contact_name}}", vars.contactName)
      .replaceAll("{{client_name}}", vars.clientName)
      .replaceAll("{{workspace_name}}", vars.workspaceName)
      .replaceAll("{{item_list}}", list)
      .replaceAll("{{account_manager}}", vars.accountManager ?? vars.workspaceName)
      .replaceAll("{{portal_link}}", `${env.appUrl}/portal`);
  return { subject: replace(rule.subject), body: replace(rule.body) };
}

/** Which of the onboarding's items a rule would remind about right now. */
export function eligibleItems(
  rule: Pick<ReminderRule, "trigger" | "offset_days" | "repeat_every_days"> & { item_scope?: ItemScope },
  items: (ReminderItem & { audience: string })[],
  history: Map<string, Date>, // item id -> last time this rule reminded about it
  now: Date,
  timeZone: string,
) {
  const today = localDate(now, timeZone);
  const scope = rule.item_scope ?? "all";
  return items.filter((item) => {
    if (item.audience !== "client") return false;
    if (!(REMINDABLE_STATUSES as readonly string[]).includes(item.status)) return false;
    if (scope !== "all" && item.kind !== scope) return false;
    const last = history.get(item.id);
    const repeatOk = (minDays: number | null) =>
      !last || (minDays != null && dayDiff(localDate(last, timeZone), today) >= minDays);
    switch (rule.trigger) {
      case "before_due": {
        if (!item.due_at) return false;
        const until = dayDiff(today, localDate(new Date(item.due_at), timeZone));
        return until >= 0 && until <= rule.offset_days && !last;
      }
      case "overdue": {
        if (!item.due_at) return false;
        const over = dayDiff(localDate(new Date(item.due_at), timeZone), today);
        return over >= Math.max(1, rule.offset_days) && repeatOk(rule.repeat_every_days);
      }
      case "no_activity": {
        const idle = dayDiff(localDate(new Date(item.updated_at), timeZone), today);
        return idle >= Math.max(1, rule.offset_days) && repeatOk(rule.repeat_every_days);
      }
    }
  });
}

/** True when this instant is inside the send window for the client's time zone and the workspace's business days. */
export function inSendWindow(
  now: Date,
  timeZone: string,
  rule: Pick<ReminderRule, "send_hour" | "business_days_only">,
  workspace: { business_days: number[]; business_end_hour: number },
) {
  const hour = localHour(now, timeZone);
  if (hour < rule.send_hour || hour >= Math.min(QUIET_HOUR, workspace.business_end_hour)) return false;
  if (rule.business_days_only && !workspace.business_days.includes(localWeekday(now, timeZone))) return false;
  return true;
}

interface RunSummary {
  considered: number;
  sent: number;
  simulated: number;
  failed: number;
  duplicatesPrevented: number;
  cancelled: number;
  skipped: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  is_demo: boolean;
  email_from_name: string | null;
  business_days: number[];
  business_end_hour: number;
}

/**
 * Who may receive client reminders: current portal members of that client. Before anyone has
 * accepted, the primary contact while their invitation is still pending. Someone whose access
 * was removed stops receiving reminders.
 */
async function clientRecipients(tx: Tx, clientId: string) {
  const members = await tx.q<{ email: string; name: string }>(
    `select u.email, u.name from memberships m join users u on u.id = m.user_id where m.role = 'client' and m.client_id = $1`,
    [clientId],
  );
  if (members.length) return members;
  return tx.q<{ email: string; name: string }>(
    `select c.primary_contact_email as email, coalesce(c.primary_contact_name, 'there') as name from clients c
     where c.id = $1 and c.primary_contact_email is not null and exists (
       select 1 from invitations i where i.client_id = c.id and i.email = c.primary_contact_email
         and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())`,
    [clientId],
  );
}

async function runForWorkspace(tx: Tx, workspace: WorkspaceRow, now: Date, summary: RunSummary) {
  const rules = await tx.q<ReminderRule>("select * from reminder_rules where enabled = true");
  if (rules.length === 0) return;

  const onboardings = await tx.q<{
    id: string;
    client_id: string;
    client_name: string;
    timezone: string;
    template_id: string | null;
    owner_user_id: string | null;
    owner_name: string | null;
  }>(
    `select o.id, o.client_id, c.name as client_name, c.timezone, o.template_id, o.owner_user_id, u.name as owner_name
     from onboardings o join clients c on c.id = o.client_id left join users u on u.id = coalesce(o.owner_user_id, c.owner_user_id)
     where o.status = 'active' and o.reminders_enabled = true and c.archived_at is null`,
  );

  for (const onb of onboardings) {
    const tz = onb.timezone;
    const items = await tx.q<ReminderItem & { audience: string }>(
      `select id, title, due_at, status, updated_at, audience, kind from onboarding_items
       where onboarding_id = $1 and audience = 'client' and removed_at is null and status = any($2) order by due_at nulls last, position`,
      [onb.id, REMINDABLE_STATUSES],
    );
    if (items.length === 0) continue;
    const contacts = await clientRecipients(tx, onb.client_id);
    if (contacts.length === 0) continue;

    for (const rule of rules) {
      if (rule.template_id && rule.template_id !== onb.template_id) continue;
      if (!inSendWindow(now, tz, rule, workspace)) continue;
      summary.considered++;
      const historyRows = await tx.q<{ item_id: string; last: Date }>(
        `select unnest(item_ids) as item_id, max(created_at) as last from email_messages
         where rule_id = $1 and onboarding_id = $2 and status in ('sent', 'simulated', 'queued') group by 1`,
        [rule.id, onb.id],
      );
      const history = new Map(historyRows.map((r) => [r.item_id, r.last]));
      const due = eligibleItems(rule, items, history, now, tz);
      if (due.length === 0) continue;
      const today = localDate(now, tz);
      let delivered = 0;
      for (const contact of contacts) {
        const rendered = renderReminder(rule, {
          contactName: contact.name.split(" ")[0] || "there",
          clientName: onb.client_name,
          workspaceName: workspace.name,
          items: due,
          timeZone: tz,
          accountManager: onb.owner_name,
        });
        const result = await sendEmail(tx, workspace, {
          workspaceId: workspace.id,
          kind: "reminder",
          to: contact.email,
          subject: rendered.subject,
          body: rendered.body,
          ruleId: rule.id,
          onboardingId: onb.id,
          itemIds: due.map((i) => i.id),
          dedupeKey: `${rule.id}:${onb.id}:${contact.email.toLowerCase()}:${today}`,
          createdAt: now,
        });
        if (!result) summary.duplicatesPrevented++;
        else if (result.status === "sent") (summary.sent++, delivered++);
        else if (result.status === "simulated") (summary.simulated++, delivered++);
        else summary.failed++;
      }
      if (delivered && rule.notify_owner && onb.owner_user_id)
        await notify(tx, {
          workspace,
          userIds: [onb.owner_user_id],
          title: `Reminder sent to ${onb.client_name}`,
          body: `"${rule.name}" reminded them about: ${due.map((i) => i.title).join(", ")}`,
          link: `/app/clients/${onb.client_id}`,
          onboardingId: onb.id,
          kind: "reminder",
          dedupeKey: `reminder:${rule.id}:${onb.id}:${today}`,
        });
    }
  }
}

/**
 * Sends reminders that automations scheduled for later. Each one is re-checked at send time and
 * cancelled when its items are done, the onboarding is paused or finished, the client is
 * archived, the requirement was removed, or the recipient no longer has access.
 */
async function processScheduled(tx: Tx, workspace: WorkspaceRow, now: Date, summary: RunSummary) {
  const due = await tx.q<{ id: string; onboarding_id: string | null; item_ids: string[]; to_email: string; subject: string; body: string }>(
    "select id, onboarding_id, item_ids, to_email, subject, body from email_messages where status = 'scheduled' and send_after <= $1 for update skip locked",
    [now],
  );
  for (const msg of due) {
    const close = async (status: "cancelled" | "skipped", reason: string) => {
      await tx.q("update email_messages set status = $2, status_reason = $3 where id = $1", [msg.id, status, reason]);
      if (status === "cancelled") summary.cancelled++;
      else summary.skipped++;
    };
    const onb = msg.onboarding_id
      ? await tx.one<{ status: string; client_id: string; client_name: string; timezone: string; archived_at: Date | null; owner_name: string | null; reminders_enabled: boolean }>(
          `select o.status, o.client_id, c.name as client_name, c.timezone, c.archived_at, u.name as owner_name, o.reminders_enabled
           from onboardings o join clients c on c.id = o.client_id left join users u on u.id = o.owner_user_id where o.id = $1`,
          [msg.onboarding_id],
        )
      : null;
    if (!onb) {
      await close("cancelled", "Onboarding no longer exists");
      continue;
    }
    if (onb.archived_at) {
      await close("cancelled", "Client archived");
      continue;
    }
    if (onb.status === "paused") {
      await close("cancelled", "Onboarding paused");
      continue;
    }
    if (onb.status !== "active") {
      await close("cancelled", `Onboarding ${onb.status}`);
      continue;
    }
    if (!onb.reminders_enabled) {
      await close("cancelled", "Reminders turned off for this client");
      continue;
    }
    const recipients = await clientRecipients(tx, onb.client_id);
    const contact = recipients.find((r) => r.email.toLowerCase() === msg.to_email.toLowerCase());
    if (!contact) {
      await close("skipped", "Recipient no longer has portal access");
      continue;
    }
    const items = await tx.q<ReminderItem>(
      `select id, title, due_at, status, updated_at, kind from onboarding_items
       where id = any($1) and removed_at is null and status = any($2) order by due_at nulls last, position`,
      [msg.item_ids, REMINDABLE_STATUSES],
    );
    if (items.length === 0) {
      await close("cancelled", "All requested items were completed or removed");
      continue;
    }
    const rendered = renderReminder(msg, {
      contactName: contact.name.split(" ")[0] || "there",
      clientName: onb.client_name,
      workspaceName: workspace.name,
      items,
      timeZone: onb.timezone,
      accountManager: onb.owner_name,
    });
    await tx.q("update email_messages set status = 'queued', subject = $2, body = $3, item_ids = $4 where id = $1", [
      msg.id,
      rendered.subject,
      rendered.body,
      items.map((i) => i.id),
    ]);
    const result = await deliverRecorded(tx, workspace, { id: msg.id, to: msg.to_email, subject: rendered.subject, body: rendered.body });
    if (!result) summary.duplicatesPrevented++;
    else if (result.status === "sent") summary.sent++;
    else if (result.status === "simulated") summary.simulated++;
    else summary.failed++;
  }
}

/** Runs all enabled reminder rules and due scheduled reminders. Safe to call repeatedly (e.g. hourly). */
export async function runReminders(opts: { now?: Date; workspaceId?: string } = {}) {
  const now = opts.now ?? new Date();
  const summary: RunSummary = { considered: 0, sent: 0, simulated: 0, failed: 0, duplicatesPrevented: 0, cancelled: 0, skipped: 0 };
  const workspaces = await sysQuery<WorkspaceRow>(
    "select id, name, is_demo, email_from_name, business_days, business_end_hour from workspaces where ($1::uuid is null or id = $1)",
    [opts.workspaceId ?? null],
  );
  for (const ws of workspaces) {
    await withTenant({ workspaceId: ws.id, userId: null, role: "system" }, async (tx) => {
      await processScheduled(tx, ws, now, summary);
      await runForWorkspace(tx, ws, now, summary);
    });
  }
  return summary;
}
