import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { emailConnection } from "@/lib/email";
import { PLACEHOLDERS, TRIGGER_LABEL, type ReminderRule } from "@/lib/reminders";
import { formatDateTime } from "@/lib/time";
import { deleteRuleAction, runRemindersNowAction, toggleRuleAction } from "../../actions";
import { RuleForm } from "./rule-form";
import { PreviewButton } from "./preview";

export const metadata = { title: "Reminders" };

function describe(r: ReminderRule) {
  const hour = `${r.send_hour % 12 || 12}${r.send_hour < 12 ? "am" : "pm"}`;
  if (r.trigger === "before_due") return `${r.offset_days} day${r.offset_days === 1 ? "" : "s"} before an item is due, once, at ${hour} client time`;
  const repeat = r.repeat_every_days ? `, repeating every ${r.repeat_every_days} days` : ", once";
  if (r.trigger === "overdue") return `${Math.max(1, r.offset_days)} day${r.offset_days > 1 ? "s" : ""} after an item is overdue${repeat}, at ${hour} client time`;
  return `After ${Math.max(1, r.offset_days)} days without activity on an item${repeat}, at ${hour} client time`;
}

export default async function RemindersPage() {
  const auth = await requireStaff();
  const admin = auth.role === "admin";
  const rules = await withTenant(tenantCtx(auth), (tx) => tx.q<ReminderRule>("select * from reminder_rules order by created_at"));
  const conn = emailConnection(auth.workspace);
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Notice tone={conn.mode === "live" ? "success" : conn.mode === "demo" ? "info" : "warning"} title={conn.mode === "live" ? "Email connected" : conn.mode === "demo" ? "Demo mode: nothing is sent" : "Email not connected"}>
          {conn.detail}
        </Notice>
        {rules.map((r) => (
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
            <p className="mt-1 text-xs text-ink-500">
              Only for client items that are Not Started, In Progress or Changes Requested. Stops automatically when items are submitted or approved, the onboarding is paused or completed, or reminders are turned off for that client. Never after 8pm client time, at most once a day per client.
            </p>
            <div className="mt-3 rounded-lg bg-ink-50 p-3 text-sm">
              <p className="font-medium">{r.subject}</p>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-ink-600">{r.body}</p>
            </div>
            {admin && (
              <div className="mt-4 flex flex-wrap items-start gap-2">
                <PreviewButton ruleId={r.id} />
                <ActionForm action={toggleRuleAction} showSuccess={false}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
                  <SubmitButton className={r.enabled ? "btn-secondary" : "btn-primary"} disabled={!r.enabled && !r.previewed_at} title={!r.previewed_at ? "Preview first" : undefined}>
                    {r.enabled ? "Disable" : "Enable"}
                  </SubmitButton>
                </ActionForm>
                <details className="w-full">
                  <summary className="cursor-pointer text-sm text-ink-600">Edit</summary>
                  <div className="mt-3">
                    <RuleForm rule={r} />
                    <ActionForm action={deleteRuleAction} className="mt-3" confirm={`Delete "${r.name}"?`}>
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
      </div>
      <div className="space-y-6">
        {admin && (
          <Card title="New reminder">
            <RuleForm />
          </Card>
        )}
        <Card title="Placeholders">
          <ul className="space-y-1 text-sm">
            {PLACEHOLDERS.map((p) => <li key={p}><code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">{p}</code></li>)}
          </ul>
        </Card>
        {admin && (
          <Card title="Run now">
            <p className="mb-3 text-sm text-ink-600">Reminders run hourly from your scheduler. You can also run them now; duplicates are always prevented.</p>
            <ActionForm action={runRemindersNowAction}>
              <SubmitButton className="btn-secondary" pendingText="Running…">Run reminders now</SubmitButton>
            </ActionForm>
          </Card>
        )}
        <Card title="Rule types">
          <ul className="space-y-1 text-sm text-ink-600">
            {Object.values(TRIGGER_LABEL).map((l) => <li key={l}>{l}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
