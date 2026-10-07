import Link from "next/link";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import {
  atRiskClients,
  blockerBreakdown,
  delayedRequirements,
  MIN_SAMPLE,
  periodMetrics,
  previousPeriod,
  readinessTrend,
  roiComparison,
  workload,
} from "@/lib/reports";
import { summarizeWorkload } from "@/lib/ai";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { formatDate, relativeDays } from "@/lib/time";
import { formatHours, formatValue, HBar, MetricTile, NOT_ENOUGH, TrendChart } from "./components";
import { parseRange, PRESETS, reviewTime } from "./data";

export const metadata = { title: "Reports" };

type Search = { range?: string; from?: string; to?: string };

const BLOCKER_HREF: Record<string, string> = {
  waiting_on_client: "/app/clients?waiting=client",
  waiting_on_staff: "/app/clients?waiting=staff",
  waiting_on_integration: "/app/clients?waiting=integration",
  deadline_overdue: "/app/clients?overdue=1",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const auth = await requireStaff();
  const sel = parseRange(await searchParams);
  const prev = previousPeriod(sel.period);
  const r = await withTenant(tenantCtx(auth), async (tx) => {
    const ws = await tx.one<{ launched_at: Date | null }>("select launched_at from workspaces where id = $1", [auth.workspace.id]);
    return {
      cur: await periodMetrics(tx, sel.period),
      prev: await periodMetrics(tx, prev),
      review: await reviewTime(tx, sel.period),
      prevReview: await reviewTime(tx, prev),
      delayed: await delayedRequirements(tx, sel.period),
      blockers: await blockerBreakdown(tx),
      atRisk: await atRiskClients(tx),
      trend: await readinessTrend(tx, sel.period),
      work: await workload(tx),
      roi: await roiComparison(tx, ws?.launched_at ?? null),
    };
  });
  const periodLabel = sel.preset ? `${sel.preset} days` : `${sel.days} days`;
  const rangeText = sel.preset ? `Last ${sel.preset} days` : `${formatDate(sel.period.from, "UTC")} – ${formatDate(new Date(sel.period.to.getTime() - 1), "UTC")}`;
  const maxBlocker = Math.max(0, ...r.blockers.map((b) => b.count));
  const workloadSummary = summarizeWorkload(r.work);
  const trendHasData = r.trend.some((p) => p.avg != null);

  return (
    <>
      <PageHeader title="Reports" description="Calculated from this workspace's onboarding records. Nothing here is estimated." />

      <Card className="mb-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Date range</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Link
                  key={p}
                  href={`/app/reports?range=${p}`}
                  className={clsx(
                    "rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition",
                    sel.preset === p ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-700 ring-ink-200 hover:bg-ink-50",
                  )}
                >
                  Last {p} days
                </Link>
              ))}
            </div>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label text-xs" htmlFor="from">From</label>
              <input id="from" name="from" type="date" className="input py-1.5" defaultValue={sel.from} required />
            </div>
            <div>
              <label className="label text-xs" htmlFor="to">To</label>
              <input id="to" name="to" type="date" className="input py-1.5" defaultValue={sel.to} required />
            </div>
            <button type="submit" className={clsx(sel.preset ? "btn-secondary" : "btn-primary", "py-1.5")}>Apply custom range</button>
          </form>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          Showing <span className="font-medium text-ink-700">{rangeText}</span>, compared with the previous {periodLabel} ({formatDate(prev.from, "UTC")} –{" "}
          {formatDate(new Date(prev.to.getTime() - 1), "UTC")}). Averages need at least {MIN_SAMPLE} records.
        </p>
        {sel.error && <Notice tone="warning" className="mt-3">{sel.error}</Notice>}
      </Card>

      {auth.workspace.is_demo && <Notice className="mb-6">These figures come from the fictional demo records, so they describe the demo data only.</Notice>}

      <section aria-label="Onboarding metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile label="Average onboarding duration" value={r.cur.avgDurationDays} previous={r.prev.avgDurationDays} unit="days" periodLabel={periodLabel} hint={`From ${plural(r.cur.durationSample, "completed onboarding")}`} />
        <MetricTile label="Median onboarding duration" value={r.cur.medianDurationDays} previous={r.prev.medianDurationDays} unit="days" periodLabel={periodLabel} hint={`From ${plural(r.cur.durationSample, "completed onboarding")}`} />
        <MetricTile label="Time waiting on client" value={r.cur.avgClientWaitHours} previous={r.prev.avgClientWaitHours} unit="hours" periodLabel={periodLabel} hint={`Average per client step · ${plural(r.cur.clientWaitSample, "step")}`} href="/app/clients?waiting=client" />
        <MetricTile label="Time waiting on staff" value={r.cur.avgStaffWaitHours} previous={r.prev.avgStaffWaitHours} unit="hours" periodLabel={periodLabel} hint={`Average in Submitted or Under Review · ${plural(r.cur.staffWaitSample, "step")}`} href="/app/clients?waiting=staff" />
        <MetricTile label="Overdue rate" value={r.cur.overdueRate} previous={r.prev.overdueRate} unit="percent" periodLabel={periodLabel} hint={`${r.cur.itemsLate} of ${plural(r.cur.itemsDue, "required item")} due in the period finished late`} href="/app/clients?overdue=1" />
        <MetricTile label="Completion rate" value={r.cur.completionRate} previous={r.prev.completionRate} unit="percent" periodLabel={periodLabel} hint={`Of onboardings started in the period`} />
        <MetricTile label="Onboardings started" value={r.cur.started} previous={r.prev.started} unit="count" periodLabel={periodLabel} hint="Excludes imported history" href="/app/clients?status=active" />
        <MetricTile label="Onboardings completed" value={r.cur.completed} previous={r.prev.completed} unit="count" periodLabel={periodLabel} />
        <MetricTile label="Average staff review time" value={r.review.hours} previous={r.prevReview.hours} unit="hours" periodLabel={periodLabel} hint={`Submission to review decision · ${plural(r.review.sample, "review")}`} href="/app/clients?waiting=staff" />
        <MetricTile label="Changes requested" value={r.cur.changesRequested} previous={r.prev.changesRequested} unit="count" periodLabel={periodLabel} hint="Times an item was sent back to the client" />
        <MetricTile label="Reminders recorded" value={r.cur.remindersSent} previous={r.prev.remindersSent} unit="count" periodLabel={periodLabel} hint={auth.workspace.is_demo ? "Demo outbox: recorded, not sent" : "Sent or recorded reminder emails"} href="/app/settings/reminders" />
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Most common blockers right now" padded={false}>
          {r.blockers.length === 0 ? (
            <div className="p-5"><EmptyState title="No blockers on active onboardings" /></div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {r.blockers.map((b) => {
                const href = BLOCKER_HREF[b.category];
                return (
                  <li key={b.category} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      {href ? <Link href={href} className="link font-medium">{b.label}</Link> : <span className="font-medium">{b.label}</span>}
                      <span className="tabular-nums text-ink-600">{b.count}</span>
                    </div>
                    <div className="mt-2"><HBar value={b.count} max={maxBlocker} /></div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">Counted across active onboardings, one per blocked item.</p>
        </Card>

        <Card title="At-risk clients" padded={false}>
          {r.atRisk.length === 0 ? (
            <div className="p-5"><EmptyState title="No clients are at risk" /></div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {r.atRisk.map((c) => (
                <li key={c.client_id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <Link href={`/app/clients/${c.client_id}`} className="link font-medium">{c.client_name}</Link>
                    {c.reason && <p className="mt-0.5 text-sm text-ink-600">{c.reason}</p>}
                  </div>
                  <div className="shrink-0 text-xs text-ink-500 sm:text-right">
                    <Badge tone="danger">At Risk</Badge>
                    <p className="mt-1">{c.since ? `since ${relativeDays(c.since)}` : ""}{c.owner ? ` · ${c.owner}` : ""}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Most frequently delayed requirements" padded={false} className="lg:col-span-2">
          {r.delayed.length === 0 ? (
            <div className="p-5"><EmptyState title="No late or sent-back requirements in this period" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="border-b border-ink-100 bg-ink-50/60">
                  <tr>
                    <th className="table-head">Requirement</th>
                    <th className="table-head text-right">Late</th>
                    <th className="table-head text-right">Average days late</th>
                    <th className="table-head text-right">Sent back</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {r.delayed.map((d) => (
                    <tr key={d.title} className="hover:bg-ink-50">
                      <td className="table-cell">
                        <p className="font-medium">{d.title}</p>
                        <p className="text-xs text-ink-500">{d.section_title}</p>
                      </td>
                      <td className="table-cell text-right tabular-nums">{d.late} of {d.total}</td>
                      <td className="table-cell text-right tabular-nums">{d.avg_days_late != null ? d.avg_days_late : "–"}</td>
                      <td className="table-cell text-right tabular-nums">{d.sent_back}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">Client requirements due in the selected period, grouped by name.</p>
        </Card>

        <Card title="Readiness trend" className="lg:col-span-2">
          {trendHasData ? (
            <>
              <TrendChart points={r.trend} />
              <p className="mt-2 text-xs text-ink-500">Average readiness of onboardings that were active at each point, reconstructed from item status history. Grey marks mean no active onboardings at that point.</p>
            </>
          ) : (
            <EmptyState title={NOT_ENOUGH} description="Readiness history appears once onboardings have been active during the selected period." />
          )}
        </Card>

        <Card
          title={
            <span className="flex flex-wrap items-center gap-2">
              Staff workload <Badge>Workload, not performance</Badge>
            </span>
          }
          padded={false}
          className="lg:col-span-2"
        >
          {r.work.length === 0 ? (
            <div className="p-5"><EmptyState title="No team members yet" /></div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead className="border-b border-ink-100 bg-ink-50/60">
                    <tr>
                      <th className="table-head">Team member</th>
                      <th className="table-head text-right">Active onboardings</th>
                      <th className="table-head text-right">Reviews waiting</th>
                      <th className="table-head text-right">Overdue tasks</th>
                      <th className="table-head text-right">Clients waiting on them</th>
                      <th className="table-head text-right">Average review time</th>
                      <th className="table-head text-right">Assigned tasks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {r.work.map((w) => (
                      <tr key={w.user_id} className="hover:bg-ink-50">
                        <td className="table-cell">
                          <p className="font-medium">{w.name}</p>
                          <p className="text-xs text-ink-500">{ROLE_LABEL[w.role as Role] ?? w.role}</p>
                        </td>
                        <td className="table-cell text-right tabular-nums">{w.active_onboardings}</td>
                        <td className="table-cell text-right tabular-nums">
                          {w.reviews_waiting}
                          {w.oldest_review && w.reviews_waiting > 0 && <span className="block text-xs text-ink-500">oldest {relativeDays(w.oldest_review)}</span>}
                        </td>
                        <td className={clsx("table-cell text-right tabular-nums", w.overdue_tasks > 0 && "text-amber-700")}>{w.overdue_tasks}</td>
                        <td className="table-cell text-right tabular-nums">{w.clients_blocked}</td>
                        <td className="table-cell text-right tabular-nums">
                          {w.avg_review_hours != null ? formatHours(w.avg_review_hours) : <span className="text-xs text-ink-400">{NOT_ENOUGH}</span>}
                        </td>
                        <td className="table-cell text-right tabular-nums">
                          <Link href={`/app/tasks?who=${w.user_id}`} className="link">{w.open_tasks}</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-ink-100 px-5 py-3">
                <p className="whitespace-pre-line text-sm text-ink-700">{workloadSummary}</p>
                <p className="mt-2 text-xs text-ink-500">
                  A snapshot of currently assigned work, to rebalance reviews and tasks. It is not a measure of anyone&apos;s performance. Review time covers the last 90 days and needs at least {MIN_SAMPLE} reviews.
                </p>
              </div>
            </>
          )}
        </Card>

        <Card title="Before vs after ClientFlow" padded={false} className="lg:col-span-2">
          {!r.roi.launchedAt ? (
            <div className="p-5">
              <EmptyState
                title={NOT_ENOUGH}
                description="Set a launch date on the Launch Checklist. Onboardings completed before it (for example, imported history) become the baseline."
                action={<Link href="/app/settings/launch" className="btn-secondary">Open Launch Checklist</Link>}
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead className="border-b border-ink-100 bg-ink-50/60">
                    <tr>
                      <th className="table-head">Measure</th>
                      <th className="table-head text-right">Before</th>
                      <th className="table-head text-right">After</th>
                      <th className="table-head text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {r.roi.rows.map((row) => {
                      const comparable =
                        row.before != null && row.after != null && row.beforeSample >= MIN_SAMPLE && row.afterSample >= MIN_SAMPLE;
                      const unit = row.unit === "days" ? "days" : row.unit === "hours" ? "hours" : "count";
                      const diff = comparable ? Math.round((row.after! - row.before!) * 10) / 10 : null;
                      return (
                        <tr key={row.label}>
                          <td className="table-cell">
                            <p className="font-medium">{row.label}</p>
                            <p className="text-xs text-ink-500">
                              {row.beforeSample} before · {row.afterSample} after
                              {row.note ? ` · ${row.note}` : ""}
                            </p>
                          </td>
                          {comparable ? (
                            <>
                              <td className="table-cell text-right tabular-nums">{formatValue(row.before!, unit)}</td>
                              <td className="table-cell text-right tabular-nums">{formatValue(row.after!, unit)}</td>
                              <td className="table-cell text-right tabular-nums">
                                {diff === 0 ? "No change" : `${diff! > 0 ? "+" : "−"}${formatValue(Math.abs(diff!), unit)}`}
                              </td>
                            </>
                          ) : (
                            <td className="table-cell text-right text-sm text-ink-400" colSpan={3}>{NOT_ENOUGH}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-ink-100 px-5 py-3 text-xs text-ink-500">
                Launched {formatDate(r.roi.launchedAt)}. &ldquo;Before&rdquo; data comes from imported historical records (onboardings completed before the launch date); &ldquo;after&rdquo; covers onboardings started since.
                Numbers appear only when both sides have at least {MIN_SAMPLE} records. This compares recorded durations and counts; it is not an estimate of hours or money saved.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
