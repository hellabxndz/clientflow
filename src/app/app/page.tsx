import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, Clock, Hourglass, Inbox, Timer, Users, Workflow } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { formatMoney, loadOnboardings, staffNames, sumContracts } from "@/lib/queries";
import { isOverdue } from "@/lib/onboarding";
import { TRIGGER_INFO, type TriggerType } from "@/lib/automation/catalog";
import { Badge, Card, EmptyState, Notice, PageHeader, ReadinessPill, Tabs } from "@/components/ui";
import { formatDate, formatDateTime, localHour } from "@/lib/time";
import { Kpi } from "./_overview/kpi";
import { BlockerCard } from "./_overview/blocker-card";

export const metadata = { title: "Overview" };

interface RunRow {
  id: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  trigger: string;
  results: { type?: string; detail?: string; status?: string }[] | null;
  error: string | null;
  created_at: Date;
  rule_name: string;
  client_id: string | null;
  client_name: string | null;
}

const RUN_TONE = { succeeded: "success", partial: "warning", failed: "danger", skipped: "neutral" } as const;
const RUN_LABEL = { succeeded: "Succeeded", partial: "Partly done", failed: "Failed", skipped: "Skipped" } as const;

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ denied?: string; mine?: string }> }) {
  const auth = await requireStaff();
  const sp = await searchParams;
  const mine = sp.mine === "1";
  const opts = { leadDays: auth.workspace.kickoff_lead_days, businessDays: auth.workspace.business_days };
  const { onboardings, names, avg, runs } = await withTenant(tenantCtx(auth), async (tx) => ({
    onboardings: await loadOnboardings(tx, "o.status in ('active','paused') and c.archived_at is null", [], opts),
    names: (await staffNames(tx)).map,
    avg: await tx.one<{ n: number; days: number | null }>(
      `select count(*)::int as n, avg(o.completed_at::date - o.start_date)::float as days
       from onboardings o
       where o.status = 'completed' and o.completed_at is not null and o.start_date is not null
         and o.source <> 'import' and o.completed_at >= now() - interval '90 days'`,
    ),
    runs: await tx.q<RunRow>(
      `select ar.id, ar.status, ar.trigger, ar.results, ar.error, ar.created_at, r.name as rule_name, c.id as client_id, c.name as client_name
       from automation_runs ar join automation_rules r on r.id = ar.rule_id left join clients c on c.id = ar.client_id
       order by ar.created_at desc limit 6`,
    ),
  }));

  const active = onboardings.filter((o) => o.status === "active");
  const paused = onboardings.length - active.length;
  const overdueRequests = active.flatMap((o) => o.items.filter((i) => !i.removed_at && i.audience === "client" && i.required && isOverdue(i)));
  const overdueClients = new Set(overdueRequests.map((i) => i.onboarding_id)).size;
  const waitingClient = active.filter((o) => o.state.waitingOn === "client");
  const waitingStaff = active.filter((o) => o.state.waitingOn === "staff");
  const ready = active.filter((o) => o.state.stage === "ready");
  const atRisk = onboardings.filter((o) => o.state.atRisk);
  const reviewItems = onboardings.flatMap((o) => o.state.awaitingReview);
  const clientSubmissions = reviewItems.filter((i) => i.audience === "client").length;
  const reviewClients = onboardings.filter((o) => o.state.awaitingReview.length > 0).length;
  const contracts = sumContracts(active.filter((o) => o.state.stage !== "ready"));
  const avgDays = avg && avg.n >= 3 && avg.days != null ? Math.round(avg.days * 10) / 10 : null;

  const blocked = active
    .filter((o) => o.state.blockers.length > 0)
    .filter((o) => !mine || o.owner_user_id === auth.user.id)
    .sort((a, b) => b.state.blockedDays - a.state.blockedDays || (a.state.readiness.score ?? 0) - (b.state.readiness.score ?? 0));

  return (
    <>
      <PageHeader
        title={`Good ${greeting(auth.workspace.timezone)}, ${auth.user.name.split(" ")[0]}`}
        description="Where every client onboarding stands, and what is holding each one up."
        actions={
          <>
            <Link href="/app/clients" className="btn-secondary">All clients</Link>
            <Link href="/app/clients/new" className="btn-primary">New client</Link>
          </>
        }
      />
      {sp.denied && (
        <Notice tone="warning" className="mb-6">
          Your role doesn&apos;t have access to that page.
        </Notice>
      )}
      <div className="mb-6">
        <Tabs active="today" tabs={[{ key: "today", href: "/app", label: "Operations" }, { key: "reports", href: "/app/reports", label: "Reports" }]} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Active onboardings" value={active.length} hint={paused ? `${paused} paused` : "None paused"} href="/app/clients?status=active" icon={<Users className="h-4 w-4" />} />
        <Kpi
          label="Overdue requests"
          value={overdueRequests.length}
          tone={overdueRequests.length ? "danger" : "neutral"}
          hint={overdueRequests.length ? `Required client items across ${overdueClients} client${overdueClients === 1 ? "" : "s"}` : "Nothing overdue"}
          href="/app/clients?overdue=1"
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <Kpi label="Waiting on client" value={waitingClient.length} tone={waitingClient.length ? "info" : "neutral"} hint="Client has items to send" href="/app/clients?waiting=client" icon={<Hourglass className="h-4 w-4" />} />
        <Kpi label="Waiting on staff" value={waitingStaff.length} tone={waitingStaff.length ? "warning" : "neutral"} hint="Our team has the next move" href="/app/clients?waiting=staff" icon={<Inbox className="h-4 w-4" />} />
        <Kpi label="Ready for kickoff" value={ready.length} tone={ready.length ? "brand" : "neutral"} hint="All required items approved" href="/app/clients?stage=ready" icon={<CalendarCheck className="h-4 w-4" />} />
        <Kpi label="At risk" value={atRisk.length} tone={atRisk.length ? "danger" : "neutral"} hint={atRisk.length ? "Flagged by escalation rules" : "No clients flagged"} href="/app/clients?risk=1" icon={<AlertTriangle className="h-4 w-4" />} />
        <Kpi
          label="Average onboarding time"
          value={avgDays != null ? `${avgDays} days` : <span className="text-base font-medium text-ink-500">Not enough data yet</span>}
          hint={avg && avg.n >= 3 ? `Start to completion, ${avg.n} completed in last 90 days` : `${avg?.n ?? 0} completed in last 90 days (3 needed)`}
          href="/app/clients?stage=completed"
          icon={<Timer className="h-4 w-4" />}
        />
        <Kpi
          label="Staff review backlog"
          value={reviewItems.length}
          tone={reviewItems.length ? "warning" : "neutral"}
          hint={reviewItems.length ? `Submissions across ${reviewClients} client${reviewClients === 1 ? "" : "s"}` : "Review queue is clear"}
          href="/app/tasks?tab=review"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
      </div>

      <Link
        href="/app/tasks?tab=review"
        className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white px-5 py-3.5 text-sm shadow-sm transition hover:border-brand-200"
      >
        <span className="min-w-0 text-ink-700">
          {clientSubmissions > 0 ? (
            <>
              <span className="font-semibold text-ink-900">{clientSubmissions} client submission{clientSubmissions === 1 ? "" : "s"}</span> awaiting staff review.
            </>
          ) : (
            "No client submissions are awaiting staff review."
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium text-brand-700">
          Review queue <ArrowRight className="h-4 w-4" />
        </span>
      </Link>

      <div className="mt-8 grid gap-6 xl:grid-cols-3">
        <section className="min-w-0 xl:col-span-2" id="blockers">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold text-ink-900">Blocked onboardings</h2>
              <p className="text-sm text-ink-500">Longest-blocked first. Open a client to unblock it.</p>
            </div>
            <div className="flex gap-1 text-sm">
              <Link href="/app" className={!mine ? "rounded-md bg-white px-2.5 py-1 font-medium shadow-sm ring-1 ring-ink-200" : "px-2.5 py-1 text-ink-500 hover:text-ink-800"}>All</Link>
              <Link href="/app?mine=1" className={mine ? "rounded-md bg-white px-2.5 py-1 font-medium shadow-sm ring-1 ring-ink-200" : "px-2.5 py-1 text-ink-500 hover:text-ink-800"}>Mine</Link>
            </div>
          </div>
          {blocked.length === 0 ? (
            <EmptyState
              title={mine ? "None of your onboardings are blocked" : "No blocked onboardings"}
              description="Nothing is overdue, waiting on review, sent back or stuck on a dependency."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {blocked.map((o) => (
                <BlockerCard key={o.id} onboarding={o} names={names} />
              ))}
            </div>
          )}
        </section>

        <div className="min-w-0 space-y-6">
          <Card title="Contract Value in Active Onboarding" action={<Link href="/app/clients?status=active" className="link text-sm">Clients</Link>}>
            {contracts.count === 0 ? (
              <p className="text-sm text-ink-500">No contract values recorded for active onboardings yet. Add one on the client.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  {contracts.monthly > 0 && <MoneyFigure label="Monthly" value={formatMoney(contracts.monthly, "monthly")} />}
                  {contracts.annual > 0 && <MoneyFigure label="Annual" value={formatMoney(contracts.annual, "annual")} />}
                  {contracts.one_time > 0 && <MoneyFigure label="One-time" value={formatMoney(contracts.one_time)} />}
                </div>
                <p className="text-xs text-ink-500">
                  Signed contract value for clients not yet ready for kickoff. Not realized revenue.
                  {` ${contracts.count} client${contracts.count === 1 ? "" : "s"}; monthly, annual and one-time totals are kept separate.`}
                </p>
              </div>
            )}
          </Card>

          <Card title="Ready for Kickoff" padded={false} action={<Link href="/app/clients?stage=ready" className="link text-sm">View all</Link>}>
            {ready.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No active onboarding has all required items approved yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {ready.slice(0, 6).map((o) => (
                  <li key={o.id}>
                    <Link href={`/app/clients/${o.client_id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-ink-50">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-900">{o.client_name}</p>
                        <p className="truncate text-xs text-ink-500">
                          {o.kickoff.basis === "scheduled"
                            ? `Kickoff ${formatDate(o.kickoff.date)}`
                            : o.handed_off_at
                              ? `Handed off ${formatDate(o.handed_off_at)}`
                              : o.kickoff.date
                                ? `Earliest kickoff ${formatDate(o.kickoff.date)}`
                                : "Book the kickoff call"}
                        </p>
                      </div>
                      <ReadinessPill score={o.state.readiness.score} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent automation activity" padded={false} action={<Link href="/app/automations" className="link text-sm">Automations</Link>}>
            {runs.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No automation rules have run yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {runs.map((r) => {
                  const detail = r.error ?? r.results?.map((x) => x.detail).filter(Boolean).join(" · ");
                  return (
                    <li key={r.id}>
                      <Link href="/app/automations" className="block px-5 py-3 hover:bg-ink-50">
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 truncate text-sm font-medium text-ink-900">{r.rule_name}</p>
                          <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-500">
                          {[r.client_name, TRIGGER_INFO[r.trigger as TriggerType]?.label ?? r.trigger].filter(Boolean).join(" · ")}
                        </p>
                        {detail && <p className="mt-0.5 truncate text-xs text-ink-600">{detail}</p>}
                        <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-400">
                          <Clock className="h-3 w-3" />
                          {formatDateTime(r.created_at, auth.workspace.timezone)}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t border-ink-100 px-5 py-3">
              <Link href="/app/automations" className="flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-800">
                <Workflow className="h-4 w-4" /> Manage automation rules
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function MoneyFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-ink-900">{value}</p>
    </div>
  );
}

function greeting(tz: string) {
  const h = localHour(new Date(), tz);
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
