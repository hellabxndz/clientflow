import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Card, EmptyState, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { emailConnection } from "@/lib/email";
import { DEFAULT_REMINDER_BODY, ITEM_SCOPE_LABEL, PLACEHOLDERS, TRIGGER_LABEL, type ItemScope, type ReminderRule } from "@/lib/reminders";
import { formatDateTime, WEEKDAY_LABEL } from "@/lib/time";
import { deleteReminderRuleAction, runRemindersAction, toggleReminderRuleAction } from "./actions";
import { RuleForm } from "./rule-form";
import { PreviewButton } from "./preview";

export const metadata = { title: "Reminders" };

const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 || h === 24 ? "am" : "pm"}`;

function describe(r: ReminderRule) {
  const hour = hourLabel(r.send_hour);
  if (r.trigger === "before_due") return `${r.offset_days} day${r.offset_days === 1 ? "" : "s"} before an item is due, once, from ${hour} client time`;
  const repeat = r.repeat_every_days ? `, repeating every ${r.repeat_every_days} days` : ", once";
  if (r.trigger === "overdue") return `${Math.max(1, r.offset_days)} day${r.offset_days > 1 ? "s" : ""} after an item is overdue${repeat}, from ${hour} client time`;
  return `After ${Math.max(1, r.offset_days)} days without activity on an item${repeat}, from ${hour} client time`;
}

const DELIVERY: Record<string, { label: string; tone: "neutral" | "brand" | "success" | "danger" | "warning" | "info" }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  queued: { label: "Queued", tone: "neutral" },
  sent: { label: "Sent", tone: "success" },
  simulated: { label: "Simulated (demo)", tone: "brand" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export default async function RemindersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const auth = await requireStaff();
  const canEdit = can(auth.role, "manageReminders");
  const sp = await searchParams;
  const statusFilter = sp.status && sp.status in DELIVERY ? sp.status : "";
  const ws = auth.workspace;
  const data = await withTenant(tenantCtx(auth), async (tx) => ({
    rules: await tx.q<ReminderRule & { template_name: string | null }>(
      "select r.*, t.name as template_name from reminder_rules r left join templates t on t.id = r.template_id order by r.created_at",
    ),
    templates: await tx.q<{ id: string; name: string }>("select id, name from templates where not archived order by name"),
    log: await tx.q<{
      id: string;
      to_email: string;
      subject: string;
      status: string;
      status_reason: string | null;
      error: string | null;
      created_at: Date;
      send_after: Date | null;
      sent_at: Date | null;
      rule_name: string | null;
      client_id: string | null;
      client_name: string | null;
      items: number;
    }>(
      `select e.id, e.to_email, e.subject, e.status, e.status_reason, e.error, e.created_at, e.send_after, e.sent_at, r.name as rule_name,
              c.id as client_id, c.name as client_name, coalesce(array_length(e.item_ids, 1), 0) as items
       from email_messages e left join reminder_rules r on r.id = e.rule_id left join onboardings o on o.id = e.onboarding_id
       left join clients c on c.id = o.client_id
       where e.kind = 'reminder' and ($1 = '' or e.status = $1) order by coalesce(e.send_after, e.created_at) desc limit 100`,
      [statusFilter],
    ),
    counts: await tx.q<{ status: string; n: number }>("select status, count(*)::int as n from email_messages where kind = 'reminder' group by status"),
  }));
  const counts = Object.fromEntries(data.counts.map((c) => [c.status, c.n]));
  const conn = emailConnection(ws);
  const scopes = (Object.keys(ITEM_SCOPE_LABEL) as ItemScope[]).map((k) => ({ value: k, label: ITEM_SCOPE_LABEL[k] }));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Notice tone={conn.mode === "live" ? "success" : conn.mode === "demo" ? "info" : "warning"} title={conn.mode === "live" ? "Email connected" : conn.mode === "demo" ? "Demo mode: nothing is sent" : "Email not connected"}>
          {conn.detail}
        </Notice>
        {!canEdit && <Notice>Only managers and admins can create, preview or enable reminder rules.</Notice>}
        {data.rules.length === 0 && <EmptyState title="No reminder rules yet" description="Create one, preview it, then enable it." />}
        {data.rules.map((r) => (
          <Card
            key={r.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {r.name}
                {r.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                {!r.previewed_at && <Badge tone="warning">Needs preview</Badge>}
              </span>
            }
          >
            <p className="text-sm text-ink-600">{describe(r)}.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="info">{TRIGGER_LABEL[r.trigger]}</Badge>
              <Badge>{ITEM_SCOPE_LABEL[r.item_scope] ?? r.item_scope}</Badge>
              <Badge>{r.template_name ? `Only: ${r.template_name}` : "Any template"}</Badge>
              {r.business_days_only && <Badge>Business days only</Badge>}
              {r.notify_owner && <Badge tone="brand">Owner notified</Badge>}
            </div>
            <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
              <p className="font-medium">{r.subject}</p>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-ink-600">{r.body}</p>
            </div>
            {canEdit && (
              <div className="mt-4 flex flex-wrap items-start gap-2">
                <PreviewButton ruleId={r.id} />
                <ActionForm action={toggleReminderRuleAction} showSuccess={false}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
                  <SubmitButton className={r.enabled ? "btn-secondary" : "btn-primary"} disabled={!r.enabled && !r.previewed_at} title={!r.previewed_at ? "Preview first" : undefined}>
                    {r.enabled ? "Disable" : "Enable"}
                  </SubmitButton>
                </ActionForm>
                <details className="w-full">
                  <summary className="cursor-pointer text-sm text-ink-600">Edit</summary>
                  <div className="mt-3">
                    <RuleForm rule={r} templates={data.templates} scopes={scopes} defaultBody={DEFAULT_REMINDER_BODY} />
                    <ActionForm action={deleteReminderRuleAction} className="mt-3" confirm={`Delete "${r.name}"?`}>
                      <input type="hidden" name="ruleId" value={r.id} />
                      <SubmitButton className="btn-danger">Delete reminder</SubmitButton>
                    </ActionForm>
                  </div>
                </details>
              </div>
            )}
            {r.previewed_at && <p className="mt-3 text-xs text-ink-400">Last previewed {formatDateTime(r.previewed_at)}</p>}
          </Card>
        ))}

        <Card
          title="Delivery log"
          padded={false}
          action={
            <div className="flex flex-wrap gap-1 text-xs">
              <Link href="/app/settings/reminders" className={statusFilter ? "link" : "font-semibold text-ink-900"}>All</Link>
              {Object.entries(DELIVERY).map(([k, v]) => (
                <Link key={k} href={`/app/settings/reminders?status=${k}`} className={statusFilter === k ? "ml-2 font-semibold text-ink-900" : "link ml-2"}>
                  {v.label} {counts[k] ? `(${counts[k]})` : ""}
                </Link>
              ))}
            </div>
          }
        >
          {data.log.length === 0 ? (
            <div className="p-5"><EmptyState title={statusFilter ? `No ${DELIVERY[statusFilter].label.toLowerCase()} reminders` : "No reminders yet"} /></div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.log.map((m) => {
                const st = DELIVERY[m.status] ?? { label: m.status, tone: "neutral" as const };
                return (
                  <li key={m.id} className="flex flex-col gap-1.5 px-5 py-3 sm:flex-row sm:items-start sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.subject}</p>
                      <p className="truncate text-xs text-ink-500">
                        {m.client_id ? <Link href={`/app/clients/${m.client_id}`} className="link">{m.client_name}</Link> : "No client"} · {m.to_email} · {m.rule_name ?? "Automation"} ·{" "}
                        {m.items} item{m.items === 1 ? "" : "s"}
                      </p>
                      {(m.status_reason || m.error) && <p className="mt-0.5 text-xs text-ink-600">{m.status_reason ?? m.error}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <span className="text-xs text-ink-400">
                        {m.status === "scheduled" && m.send_after ? `for ${formatDateTime(m.send_after)}` : formatDateTime(m.sent_at ?? m.created_at)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        {canEdit && (
          <Card title="New reminder">
            <RuleForm templates={data.templates} scopes={scopes} defaultBody={DEFAULT_REMINDER_BODY} />
          </Card>
        )}
        <Card title="Sending window">
          <ul className="space-y-1.5 text-sm text-ink-600">
            <li>Business days: <span className="font-medium text-ink-800">{ws.business_days.map((d) => WEEKDAY_LABEL[d]).join(", ")}</span></li>
            <li>Business hours: <span className="font-medium text-ink-800">{hourLabel(ws.business_start_hour)}–{hourLabel(ws.business_end_hour)}</span></li>
            <li>Workspace time zone: <span className="font-medium text-ink-800">{ws.timezone}</span></li>
          </ul>
          <p className="mt-2 text-xs text-ink-500">
            Reminders go out in each client&apos;s own time zone, from the rule&apos;s hour until business hours end, and never after 8pm. At most one email per rule, client contact and day.{" "}
            <Link href="/app/settings" className="link">Change business hours</Link>
          </p>
        </Card>
        <Card title="When reminders stop">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-600">
            <li>The item is completed (submitted, under review or approved)</li>
            <li>The onboarding is completed or paused</li>
            <li>The client is archived</li>
            <li>The requirement was removed</li>
            <li>The contact no longer has portal access</li>
            <li>Reminders are turned off for that client</li>
          </ul>
          <p className="mt-2 text-xs text-ink-500">Scheduled reminders are re-checked at send time and marked Cancelled or Skipped with the reason. Duplicates are prevented with a unique key per rule, onboarding, contact and day.</p>
        </Card>
        <Card title="Escalations">
          <p className="text-sm text-ink-600">Internal escalations (for example, notify a manager when a client has been blocked for 5 days) are automation rules.</p>
          <Link href="/app/automations" className="link mt-2 inline-block text-sm">Open Automations</Link>
        </Card>
        {canEdit && (
          <Card title="Run now">
            <p className="mb-3 text-sm text-ink-600">Reminders run on your scheduler. You can also run them now; duplicates are always prevented.</p>
            <ActionForm action={runRemindersAction}>
              <SubmitButton className="btn-secondary" pendingText="Running…">Run reminders now</SubmitButton>
            </ActionForm>
          </Card>
        )}
        <Card title="Placeholders">
          <ul className="flex flex-wrap gap-1.5 text-sm">
            {PLACEHOLDERS.map((p) => <li key={p}><code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">{p}</code></li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
