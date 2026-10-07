import Link from "next/link";
import { Activity, Plus } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { toggleAutomationRuleAction } from "./actions";
import { loadRules, loadVocabulary, type RuleListRow } from "./data";
import { CATEGORY_INFO, describeRule, rowToInput, type Vocabulary } from "./describe";
import { IfThen, RunStatusBadge } from "./ui";

export const metadata = { title: "Automations" };

export default async function AutomationsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const auth = await requireStaff();
  const manager = auth.role === "admin" || auth.role === "manager";
  const { saved } = await searchParams;
  const { rules, vocab, pending } = await withTenant(tenantCtx(auth), async (tx) => ({
    rules: await loadRules(tx),
    vocab: await loadVocabulary(tx),
    pending: Number(
      (await tx.one<{ n: number }>("select count(*)::int as n from automation_events where processed_at is null or (error is not null and attempts >= 3)"))?.n ?? 0,
    ),
  }));
  const example = rules.find(
    (r) => r.actions.some((a) => a.type === "mark_ready_for_kickoff") && r.conditions.filter((c) => c.type === "item_status" || c.type === "section_complete").length >= 2,
  );

  return (
    <div>
      <PageHeader
        title="Automations"
        description="Rules that move onboarding forward, escalate delays and hand clients off to delivery."
        actions={
          <>
            <Link href="/app/automations/activity" className="btn-secondary">
              <Activity className="h-4 w-4" /> Activity log
              {pending > 0 && <Badge tone="warning">{pending}</Badge>}
            </Link>
            {manager && (
              <Link href="/app/automations/new" className="btn-primary">
                <Plus className="h-4 w-4" /> New automation
              </Link>
            )}
          </>
        }
      />
      {saved && (
        <Notice tone="success" className="mb-6">
          Automation saved.
        </Notice>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-8 xl:col-span-2">
          {rules.length === 0 && (
            <EmptyState
              title="No automations yet"
              description="Create a rule such as “When a closed-won deal arrives, start onboarding and invite the client”."
              action={manager ? <Link href="/app/automations/new" className="btn-primary">New automation</Link> : undefined}
            />
          )}
          {(Object.keys(CATEGORY_INFO) as RuleListRow["category"][]).map((cat) => {
            const list = rules.filter((r) => r.category === cat);
            return (
              <section key={cat}>
                <div className="mb-3">
                  <h2 className="text-[15px] font-semibold text-ink-900">
                    {CATEGORY_INFO[cat].label} <span className="font-normal text-ink-400">({list.length})</span>
                  </h2>
                  <p className="text-sm text-ink-500">{CATEGORY_INFO[cat].help}</p>
                </div>
                {list.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-ink-200 bg-white px-4 py-6 text-center text-sm text-ink-500">No {CATEGORY_INFO[cat].label.toLowerCase()} rules yet.</p>
                ) : (
                  <div className="card divide-y divide-ink-100">
                    {list.map((r) => (
                      <RuleRow key={r.id} rule={r} vocab={vocab} manager={manager} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <div className="space-y-6">
          {example && (
            <Card title="Spec example">
              <p className="mb-3 text-sm text-ink-600">
                <Link href={`/app/automations/${example.id}`} className="link">
                  {example.name}
                </Link>
              </p>
              <SpecExample rule={example} vocab={vocab} />
            </Card>
          )}
          <Card title="How runs are kept safe">
            <ul className="space-y-2 text-sm text-ink-600">
              <li>Each rule runs at most once per onboarding, or once per event if you choose “every time”. The database enforces this with a unique run key, so retries and overlapping jobs never send a second email or create a second task.</li>
              <li>Each action runs on its own: if one fails (for example Slack isn’t connected), the others still run and the failure is shown in the activity log.</li>
              <li>Events are processed right after each change and again by the scheduled job every few minutes, so nothing is lost if a step fails.</li>
              {auth.workspace.is_demo && <li>Demo workspace: emails are recorded in the outbox and never sent; Slack, Teams and PM tools are never called.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SpecExample({ rule, vocab }: { rule: RuleListRow; vocab: Vocabulary }) {
  const d = describeRule(rowToInput(rule), vocab);
  return (
    <div className="space-y-1.5 text-sm">
      {d.conditions.map((c, i) => (
        <p key={i} className="flex gap-2">
          <span className="w-10 shrink-0 text-[11px] font-bold uppercase tracking-wider text-ink-500">{i === 0 ? "IF" : d.joiner}</span>
          <span className="text-ink-800">{c}</span>
        </p>
      ))}
      <p className="flex gap-2 pt-1">
        <span className="w-10 shrink-0 text-[11px] font-bold uppercase tracking-wider text-brand-700">THEN</span>
        <span className="font-medium text-brand-800">{d.actions.join(", ")}</span>
      </p>
      <p className="pt-2 text-xs text-ink-500">Checked when: {d.when}.</p>
    </div>
  );
}

function RuleRow({ rule, vocab, manager }: { rule: RuleListRow; vocab: Vocabulary; manager: boolean }) {
  const d = describeRule(rowToInput(rule), vocab);
  return (
    <div className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/app/automations/${rule.id}`} className="font-medium text-ink-900 hover:text-brand-700">
              {rule.name}
            </Link>
            {rule.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
            <Badge tone="info">{runModeLabel(rule.trigger, rule.run_mode)}</Badge>
            {d.scope && <Badge tone="brand">{d.scope} only</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-600">{d.sentence}</p>
        </div>
        {manager && (
          <div className="flex shrink-0 items-center gap-2">
            <ActionForm action={toggleAutomationRuleAction} showSuccess={false}>
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
              <SubmitButton className={rule.enabled ? "btn-secondary" : "btn-primary"} pendingText="…">
                {rule.enabled ? "Turn off" : "Turn on"}
              </SubmitButton>
            </ActionForm>
            <Link href={`/app/automations/${rule.id}/edit`} className="btn-ghost">
              Edit
            </Link>
          </div>
        )}
      </div>
      <div className="mt-3 rounded-lg bg-ink-50 p-3">
        <IfThen {...d} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          Last run: <RunStatusBadge status={rule.last_status} /> {rule.last_run_at && formatDateTime(rule.last_run_at)}
        </span>
        <Link href={`/app/automations/activity?rule=${rule.id}`} className="hover:text-brand-700">
          {rule.runs_total} run{rule.runs_total === 1 ? "" : "s"} · {rule.runs_succeeded} succeeded
          {rule.runs_failed > 0 && <span className="text-rose-700"> · {rule.runs_failed} with failures</span>}
        </Link>
      </div>
    </div>
  );
}

/** Time-based rules are keyed by what they watch (one overdue item, one waiting review, one quiet spell), whatever the run mode. */
function runModeLabel(trigger: string, runMode: string) {
  if (trigger === "deadline_overdue" || trigger === "deadline_approaching" || trigger === "task_overdue") return "Once per item and due date";
  if (trigger === "review_waiting") return "Once per waiting submission";
  if (trigger === "client_inactive") return "Once per quiet period";
  return runMode === "once_per_onboarding" ? "Once per onboarding" : "Every event";
}
