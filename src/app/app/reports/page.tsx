import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { getReports } from "@/lib/reports";
import { Card, EmptyState, Notice, PageHeader, Stat, Tabs } from "@/components/ui";
import { formatDate } from "@/lib/time";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
  const auth = await requireStaff();
  const r = await withTenant(tenantCtx(auth), (tx) => getReports(tx));
  const maxLoad = Math.max(1, ...r.workload.map((w) => w.open_tasks + w.reviews_waiting));

  return (
    <>
      <PageHeader title="Reports" description="Calculated from this workspace's onboarding records. Nothing here is estimated." />
      <div className="mb-6">
        <Tabs active="reports" tabs={[{ key: "today", href: "/app", label: "Today" }, { key: "reports", href: "/app/reports", label: "Reports" }]} />
      </div>
      {auth.workspace.is_demo && (
        <Notice className="mb-6">These figures come from the fictional demo records, so they describe the demo data only.</Notice>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Average onboarding duration"
          value={r.duration.avg_days != null ? `${r.duration.avg_days} days` : "–"}
          hint={r.duration.completed ? `from ${r.duration.completed} completed onboarding${r.duration.completed === 1 ? "" : "s"}` : "no completed onboardings yet"}
        />
        <Stat label="Median duration" value={r.duration.median_days != null ? `${r.duration.median_days} days` : "–"} hint={r.duration.completed ? `range ${r.duration.min_days}–${r.duration.max_days} days` : undefined} />
        <Stat label="Overdue items" value={r.overdueTotals.client_side + r.overdueTotals.staff_side} tone={r.overdueTotals.client_side + r.overdueTotals.staff_side ? "warning" : undefined} hint={`${r.overdueTotals.client_side} on clients, ${r.overdueTotals.staff_side} on the team`} />
        <Stat
          label="Average review turnaround"
          value={r.reviewTurnaround.avg_hours != null ? `${r.reviewTurnaround.avg_hours} h` : "–"}
          hint={`from ${r.reviewTurnaround.reviews} reviewed submission${r.reviewTurnaround.reviews === 1 ? "" : "s"}`}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title="Common blockers" padded={false}>
          {r.commonBlockers.length === 0 ? (
            <div className="p-5"><EmptyState title="No recurring blockers yet" /></div>
          ) : (
            <table className="w-full">
              <thead className="border-b border-ink-100 bg-ink-50/60">
                <tr>
                  <th className="table-head">Item</th>
                  <th className="table-head text-right">Overdue now</th>
                  <th className="table-head text-right">Changes requested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {r.commonBlockers.map((b) => (
                  <tr key={b.title + b.section_title}>
                    <td className="table-cell">
                      <p className="font-medium">{b.title}</p>
                      <p className="text-xs text-ink-500">{b.section_title}</p>
                    </td>
                    <td className="table-cell text-right tabular-nums">{b.overdue_now}</td>
                    <td className="table-cell text-right tabular-nums">{b.changes_requested_events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Staff workload" padded={false}>
          <ul className="divide-y divide-ink-100">
            {r.workload.map((w) => (
              <li key={w.user_id} className="px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{w.name}</p>
                  <p className="text-xs text-ink-500">
                    {w.active_onboardings} onboarding{w.active_onboardings === 1 ? "" : "s"} · {w.open_tasks} open task{w.open_tasks === 1 ? "" : "s"}
                    {w.overdue_tasks ? <span className="text-rose-700"> ({w.overdue_tasks} overdue)</span> : null} · {w.reviews_waiting} to review
                  </p>
                </div>
                <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ink-100">
                  <div className="bg-brand-500" style={{ width: `${(w.open_tasks / maxLoad) * 100}%` }} title="Open tasks" />
                  <div className="bg-amber-400" style={{ width: `${(w.reviews_waiting / maxLoad) * 100}%` }} title="Reviews waiting" />
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-brand-500" /> open tasks
            <span className="ml-3 mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" /> submissions waiting for review
          </p>
        </Card>

        <Card title="Clients with overdue items" padded={false} className="lg:col-span-2">
          {r.overdueByClient.length === 0 ? (
            <div className="p-5"><EmptyState title="Nothing overdue" /></div>
          ) : (
            <table className="w-full">
              <thead className="border-b border-ink-100 bg-ink-50/60">
                <tr>
                  <th className="table-head">Client</th>
                  <th className="table-head text-right">Overdue items</th>
                  <th className="table-head text-right">Oldest due date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {r.overdueByClient.map((c) => (
                  <tr key={c.client_id}>
                    <td className="table-cell"><Link href={`/app/clients/${c.client_id}`} className="link">{c.client_name}</Link></td>
                    <td className="table-cell text-right tabular-nums">{c.overdue}</td>
                    <td className="table-cell text-right">{formatDate(c.oldest_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <p className="mt-6 text-xs text-ink-500">
        Durations run from when an onboarding was created to when completion was approved. Onboardings: {r.counts.active} active, {r.counts.paused} paused, {r.counts.completed} completed.
      </p>
    </>
  );
}
