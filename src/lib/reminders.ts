import { sysQuery, withTenant, type Tx } from "./db";
import { env } from "./env";
import { sendEmail } from "./email";
import { dayDiff, localDate, localHour, formatDate } from "./time";

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
}

export const TRIGGER_LABEL: Record<ReminderRule["trigger"], string> = {
  before_due: "Before the due date",
  overdue: "After an item is overdue",
  no_activity: "When nothing has happened for a while",
};

/** Client statuses that still need client action. Submitted and approved items never trigger reminders. */
export const REMINDABLE_STATUSES = ["not_started", "in_progress", "changes_requested"] as const;
const QUIET_HOUR = 20; // never send after 8pm in the client's time zone

export const PLACEHOLDERS = ["{{contact_name}}", "{{client_name}}", "{{workspace_name}}", "{{item_list}}", "{{portal_link}}"];

export interface ReminderItem {
  id: string;
  title: string;
  due_at: Date | null;
  status: string;
  updated_at: Date;
}

export function renderReminder(
  rule: Pick<ReminderRule, "subject" | "body">,
  vars: { contactName: string; clientName: string; workspaceName: string; items: ReminderItem[]; timeZone: string },
) {
  const list = vars.items
    .map((i) => `- ${i.title}${i.due_at ? ` (due ${formatDate(i.due_at, vars.timeZone)})` : ""}${i.status === "changes_requested" ? " - changes requested" : ""}`)
    .join("\n");
  const replace = (s: string) =>
    s
      .replaceAll("{{contact_name}}", vars.contactName)
      .replaceAll("{{client_name}}", vars.clientName)
      .replaceAll("{{workspace_name}}", vars.workspaceName)
      .replaceAll("{{item_list}}", list)
      .replaceAll("{{portal_link}}", `${env.appUrl}/portal`);
  return { subject: replace(rule.subject), body: replace(rule.body) };
}

/** Which of the onboarding's items a rule would remind about right now. */
export function eligibleItems(
  rule: ReminderRule,
  items: (ReminderItem & { audience: string })[],
  history: Map<string, Date>, // item id -> last time this rule reminded about it
  now: Date,
  timeZone: string,
) {
  const today = localDate(now, timeZone);
  return items.filter((item) => {
    if (item.audience !== "client") return false;
    if (!(REMINDABLE_STATUSES as readonly string[]).includes(item.status)) return false;
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

interface RunSummary {
  considered: number;
  sent: number;
  simulated: number;
  failed: number;
  duplicatesPrevented: number;
}

async function runForWorkspace(tx: Tx, workspace: { id: string; name: string; is_demo: boolean; email_from_name: string | null }, now: Date, summary: RunSummary) {
  const rules = await tx.q<ReminderRule>("select * from reminder_rules where enabled = true");
  if (rules.length === 0) return;

  const onboardings = await tx.q<{
    id: string;
    client_id: string;
    client_name: string;
    timezone: string;
    primary_contact_name: string | null;
    primary_contact_email: string | null;
  }>(
    `select o.id, o.client_id, c.name as client_name, c.timezone, c.primary_contact_name, c.primary_contact_email
     from onboardings o join clients c on c.id = o.client_id
     where o.status = 'active' and o.reminders_enabled = true`,
  );

  for (const onb of onboardings) {
    const tz = onb.timezone;
    const hour = localHour(now, tz);
    const contacts = await tx.q<{ email: string; name: string }>(
      `select u.email, u.name from memberships m join users u on u.id = m.user_id
       where m.role = 'client' and m.client_id = $1`,
      [onb.client_id],
    );
    if (contacts.length === 0 && onb.primary_contact_email)
      contacts.push({ email: onb.primary_contact_email, name: onb.primary_contact_name ?? "there" });
    if (contacts.length === 0) continue;

    const items = await tx.q<ReminderItem & { audience: string }>(
      `select id, title, due_at, status, updated_at, audience from onboarding_items
       where onboarding_id = $1 and audience = 'client' and status = any($2) order by due_at nulls last, position`,
      [onb.id, REMINDABLE_STATUSES],
    );
    if (items.length === 0) continue;

    for (const rule of rules) {
      if (hour < rule.send_hour || hour >= QUIET_HOUR) continue;
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
      for (const contact of contacts) {
        const rendered = renderReminder(rule, {
          contactName: contact.name.split(" ")[0] || "there",
          clientName: onb.client_name,
          workspaceName: workspace.name,
          items: due,
          timeZone: tz,
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
        else if (result.status === "sent") summary.sent++;
        else if (result.status === "simulated") summary.simulated++;
        else summary.failed++;
      }
    }
  }
}

/** Runs all enabled reminder rules. Safe to call repeatedly (e.g. hourly); duplicates are prevented. */
export async function runReminders(opts: { now?: Date; workspaceId?: string } = {}) {
  const now = opts.now ?? new Date();
  const summary: RunSummary = { considered: 0, sent: 0, simulated: 0, failed: 0, duplicatesPrevented: 0 };
  const workspaces = await sysQuery<{ id: string; name: string; is_demo: boolean; email_from_name: string | null }>(
    "select id, name, is_demo, email_from_name from workspaces where ($1::uuid is null or id = $1)",
    [opts.workspaceId ?? null],
  );
  for (const ws of workspaces) {
    await withTenant({ workspaceId: ws.id, userId: null, role: "system" }, (tx) => runForWorkspace(tx, ws, now, summary));
  }
  return summary;
}
