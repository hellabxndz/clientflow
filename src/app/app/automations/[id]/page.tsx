import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, Meta, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { TRIGGER_INFO } from "@/lib/automation/catalog";
import { formatDateTime } from "@/lib/time";
import { loadRules, loadVocabulary } from "../data";
import { CATEGORY_INFO, describeRule, rowToInput } from "../describe";
import { IfThen, RunStatusBadge } from "../ui";
import { loadRuns, RunTable } from "../runs";
import { toggleAutomationRuleAction } from "../actions";

export const metadata = { title: "Automation" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStaff();
  const manager = auth.role === "admin" || auth.role === "manager";
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { rule, vocab, runs } = await withTenant(tenantCtx(auth), async (tx) => ({
    rule: (await loadRules(tx, "r.id = $1", [id]))[0],
    vocab: await loadVocabulary(tx),
    runs: await loadRuns(tx, { ruleId: id, limit: 25 }),
  }));
  if (!rule) notFound();
  const d = describeRule(rowToInput(rule), vocab);
  return (
    <div>
      <Link href="/app/automations" className="link text-sm">
        ← Automations
      </Link>
      <div className="mt-2">
        <PageHeader
          title={rule.name}
          description={rule.description ?? d.sentence}
          actions={
            manager && (
              <>
                <ActionForm action={toggleAutomationRuleAction} showSuccess={false}>
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                  <SubmitButton className={rule.enabled ? "btn-secondary" : "btn-primary"} pendingText="…">
                    {rule.enabled ? "Turn off" : "Turn on"}
                  </SubmitButton>
                </ActionForm>
                <Link href={`/app/automations/${rule.id}/edit`} className="btn-primary">
                  Edit
                </Link>
              </>
            )
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card title="Rule">
            <IfThen {...d} />
            <p className="mt-4 text-sm text-ink-600">{d.sentence}</p>
            <p className="mt-2 text-xs text-ink-500">{TRIGGER_INFO[rule.trigger as keyof typeof TRIGGER_INFO]?.help}</p>
          </Card>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-ink-900">Recent runs</h2>
              <Link href={`/app/automations/activity?rule=${rule.id}`} className="link text-sm">
                Full activity log
              </Link>
            </div>
            <RunTable runs={runs} showRule={false} />
          </div>
        </div>
        <Card title="Details">
          <div className="space-y-4">
            <Meta label="Status">{rule.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}</Meta>
            <Meta label="Category">{CATEGORY_INFO[rule.category].label}</Meta>
            <Meta label="Applies to">{d.scope ? `Onboardings using ${d.scope}` : "All templates"}</Meta>
            <Meta label="How often">
              {rule.run_mode === "once_per_onboarding" ? "At most once per onboarding" : "Once per event"}
              <span className="mt-1 block text-xs text-ink-500">Enforced by the database: a run key can only be used once, so retries never repeat actions.</span>
            </Meta>
            <Meta label="Last run">
              <span className="flex flex-wrap items-center gap-2">
                <RunStatusBadge status={rule.last_status} /> {rule.last_run_at && <span className="text-sm text-ink-600">{formatDateTime(rule.last_run_at)}</span>}
              </span>
            </Meta>
            <Meta label="Runs">
              {rule.runs_total} total · {rule.runs_succeeded} succeeded · {rule.runs_failed} with failures
            </Meta>
            <Meta label="Last changed">{formatDateTime(rule.updated_at)}</Meta>
          </div>
        </Card>
      </div>
    </div>
  );
}
