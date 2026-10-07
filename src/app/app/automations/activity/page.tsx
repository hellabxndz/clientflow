import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { processAutomationsNowAction } from "../actions";
import { loadRuns, RUN_STATUSES, RunTable } from "../runs";
import { RUN_STATUS_LABEL } from "../ui";

export const metadata = { title: "Automation activity" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StuckEvent {
  id: string;
  type: string;
  client_id: string | null;
  client_name: string | null;
  attempts: number;
  error: string | null;
  processed_at: Date | null;
  created_at: Date;
}

export default async function AutomationActivityPage({ searchParams }: { searchParams: Promise<{ rule?: string; status?: string }> }) {
  const auth = await requireStaff();
  const manager = auth.role === "admin" || auth.role === "manager";
  const sp = await searchParams;
  const ruleId = sp.rule && UUID.test(sp.rule) ? sp.rule : null;
  const status = sp.status && (RUN_STATUSES as readonly string[]).includes(sp.status) ? sp.status : null;
  const { runs, rules, events, counts } = await withTenant(tenantCtx(auth), async (tx) => ({
    runs: await loadRuns(tx, { ruleId, status, limit: 150 }),
    rules: await tx.q<{ id: string; name: string }>("select id, name from automation_rules order by name"),
    events: await tx.q<StuckEvent>(
      `select e.id, e.type, e.client_id, c.name as client_name, e.attempts, e.error, e.processed_at, e.created_at
       from automation_events e left join clients c on c.id = e.client_id
       where e.processed_at is null or (e.error is not null and e.attempts >= 3)
       order by e.created_at desc limit 50`,
    ),
    counts: await tx.q<{ status: string; n: number }>(
      "select status, count(*)::int as n from automation_runs where created_at > now() - interval '30 days' group by status",
    ),
  }));
  const count = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const filterHref = (patch: { rule?: string | null; status?: string | null }) => {
    const q = new URLSearchParams();
    const r = patch.rule !== undefined ? patch.rule : ruleId;
    const s = patch.status !== undefined ? patch.status : status;
    if (r) q.set("rule", r);
    if (s) q.set("status", s);
    const qs = q.toString();
    return `/app/automations/activity${qs ? `?${qs}` : ""}`;
  };
  const pending = events.filter((e) => !e.processed_at);
  const failed = events.filter((e) => e.processed_at);

  return (
    <div>
      <Link href="/app/automations" className="link text-sm">
        ← Automations
      </Link>
      <div className="mt-2">
        <PageHeader title="Automation activity" description="Every rule run, newest first, with the result of each action." />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <form method="get" action="/app/automations/activity" className="card flex flex-wrap items-end gap-3 p-4">
            <label className="min-w-0 flex-1 basis-56">
              <span className="label">Rule</span>
              <select name="rule" defaultValue={ruleId ?? ""} className="input">
                <option value="">All rules</option>
                {rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 basis-40">
              <span className="label">Status</span>
              <select name="status" defaultValue={status ?? ""} className="input">
                <option value="">Any status</option>
                {RUN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {RUN_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-secondary" type="submit">
              Filter
            </button>
            {(ruleId || status) && (
              <Link href="/app/automations/activity" className="btn-ghost">
                Clear
              </Link>
            )}
          </form>
          <RunTable runs={runs} />
          {runs.length === 150 && <p className="text-center text-xs text-ink-500">Showing the latest 150 runs. Filter by rule or status to see older ones.</p>}
        </div>

        <div className="space-y-6">
          <Card title="Last 30 days">
            <div className="grid grid-cols-2 gap-3">
              {RUN_STATUSES.map((s) => (
                <Link key={s} href={filterHref({ status: s })} className="rounded-lg border border-ink-100 p-3 hover:border-brand-200 hover:bg-ink-50">
                  <p className="text-xs text-ink-500">{RUN_STATUS_LABEL[s]}</p>
                  <p className={`mt-1 text-xl font-semibold ${s === "failed" && count(s) ? "text-rose-700" : s === "partial" && count(s) ? "text-amber-700" : "text-ink-900"}`}>{count(s)}</p>
                </Link>
              ))}
            </div>
          </Card>

          <Card title="Queue">
            {pending.length === 0 && failed.length === 0 ? (
              <p className="text-sm text-ink-600">Nothing waiting. Every event has been processed.</p>
            ) : (
              <div className="space-y-4">
                {pending.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Waiting to be processed ({pending.length})</p>
                    <EventList events={pending} />
                  </div>
                )}
                {failed.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-600">Gave up after 3 attempts ({failed.length})</p>
                    <EventList events={failed} />
                  </div>
                )}
              </div>
            )}
            {manager ? (
              <ActionForm action={processAutomationsNowAction} className="mt-4">
                <SubmitButton className="btn-secondary" pendingText="Processing…">
                  Process pending events now
                </SubmitButton>
              </ActionForm>
            ) : (
              <p className="mt-4 text-xs text-ink-500">Managers can process the queue manually.</p>
            )}
            <p className="mt-3 text-xs text-ink-500">
              Events are processed right after each change and by the scheduled job every few minutes. Deadline, inactivity and review-wait rules are
              checked on the same schedule.
            </p>
          </Card>

          <Notice title="Why nothing runs twice">
            Each rule runs at most once per onboarding (or once per event, if the rule says so). The database records every run under a unique key and
            refuses a second one, so retries, overlapping scheduled jobs and double clicks can’t repeat an email, notification or task.
          </Notice>
        </div>
      </div>
    </div>
  );
}

function EventList({ events }: { events: StuckEvent[] }) {
  return (
    <ul className="mt-2 divide-y divide-ink-100 text-sm">
      {events.map((e) => (
        <li key={e.id} className="py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-ink-800">
              {e.type.replace(/_/g, " ")}
              {e.client_id && (
                <>
                  {" · "}
                  <Link href={`/app/clients/${e.client_id}`} className="link font-normal">
                    {e.client_name ?? "Client"}
                  </Link>
                </>
              )}
            </span>
            <Badge tone={e.attempts > 0 ? "warning" : "neutral"}>
              {e.attempts} attempt{e.attempts === 1 ? "" : "s"}
            </Badge>
          </div>
          <p className="text-xs text-ink-500">{formatDateTime(e.created_at)}</p>
          {e.error && <p className="mt-0.5 break-words text-xs text-rose-700">{e.error}</p>}
        </li>
      ))}
    </ul>
  );
}
