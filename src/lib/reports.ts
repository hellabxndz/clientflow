import type { Tx } from "./db";
import { computeBlockers, computeReadiness, BLOCKER_LABEL, type BlockerCategory, type ItemLike, type ItemStatus } from "./onboarding";

/**
 * Every metric here is computed from stored records: onboardings, item status history, reviews
 * and emails. Nothing is estimated, extrapolated or invented. When there isn't enough data,
 * the value is null and the UI says "Not enough data yet."
 */

export const MIN_SAMPLE = 3;

export interface Period {
  from: Date;
  to: Date;
}

export function previousPeriod(p: Period): Period {
  const len = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - len), to: new Date(p.from.getTime()) };
}

export interface PeriodMetrics {
  started: number;
  completed: number;
  completionRate: number | null;
  avgDurationDays: number | null;
  medianDurationDays: number | null;
  durationSample: number;
  avgClientWaitHours: number | null;
  clientWaitSample: number;
  avgStaffWaitHours: number | null;
  staffWaitSample: number;
  itemsDue: number;
  itemsLate: number;
  overdueRate: number | null;
  remindersSent: number;
  changesRequested: number;
}

export async function periodMetrics(tx: Tx, p: Period): Promise<PeriodMetrics> {
  const [vol] = await tx.q<{ started: number; started_completed: number; completed: number; avg: number | null; median: number | null; n: number }>(
    `select
       count(*) filter (where start_date >= $1::date and start_date < $2::date and source <> 'import')::int as started,
       count(*) filter (where start_date >= $1::date and start_date < $2::date and source <> 'import' and status = 'completed')::int as started_completed,
       count(*) filter (where completed_at >= $1 and completed_at < $2 and status = 'completed')::int as completed,
       round(avg(extract(epoch from completed_at - start_date::timestamptz) / 86400) filter (where completed_at >= $1 and completed_at < $2 and status = 'completed')::numeric, 1)::float as avg,
       round((percentile_cont(0.5) within group (order by extract(epoch from completed_at - start_date::timestamptz) / 86400)
         filter (where completed_at >= $1 and completed_at < $2 and status = 'completed'))::numeric, 1)::float as median,
       count(*) filter (where completed_at >= $1 and completed_at < $2 and status = 'completed')::int as n
     from onboardings`,
    [p.from, p.to],
  );
  // Time in each status, from the status history: a segment ends when the item moves on.
  const [wait] = await tx.q<{ client_avg: number | null; client_n: number; staff_avg: number | null; staff_n: number }>(
    `with seg as (
       select h.to_status, i.audience,
              extract(epoch from lead(h.created_at) over (partition by h.item_id order by h.created_at, h.id) - h.created_at) / 3600 as hours,
              lead(h.created_at) over (partition by h.item_id order by h.created_at, h.id) as ended
       from item_status_history h join onboarding_items i on i.id = h.item_id
     )
     select round(avg(hours) filter (where audience = 'client' and to_status in ('not_started', 'in_progress', 'changes_requested'))::numeric, 1)::float as client_avg,
            count(*) filter (where audience = 'client' and to_status in ('not_started', 'in_progress', 'changes_requested'))::int as client_n,
            round(avg(hours) filter (where to_status in ('submitted', 'under_review'))::numeric, 1)::float as staff_avg,
            count(*) filter (where to_status in ('submitted', 'under_review'))::int as staff_n
     from seg where ended >= $1 and ended < $2`,
    [p.from, p.to],
  );
  const [late] = await tx.q<{ due: number; late: number }>(
    `with done as (
       select item_id, min(created_at) as at from item_status_history where to_status in ('submitted', 'under_review', 'approved') group by item_id
     )
     select count(*)::int as due,
            count(*) filter (where coalesce(d.at, now()) > i.due_at)::int as late
     from onboarding_items i left join done d on d.item_id = i.id join onboardings o on o.id = i.onboarding_id
     where i.removed_at is null and i.required and i.due_at >= $1 and i.due_at < least($2, now()) and o.status <> 'cancelled'`,
    [p.from, p.to],
  );
  const [mail] = await tx.q<{ reminders: number }>(
    `select count(*)::int as reminders from email_messages where kind = 'reminder' and status in ('sent', 'simulated') and created_at >= $1 and created_at < $2`,
    [p.from, p.to],
  );
  const [cr] = await tx.q<{ n: number }>(
    "select count(*)::int as n from item_status_history where to_status = 'changes_requested' and created_at >= $1 and created_at < $2",
    [p.from, p.to],
  );
  return {
    started: vol.started,
    completed: vol.completed,
    completionRate: vol.started >= MIN_SAMPLE ? Math.round((vol.started_completed / vol.started) * 100) : null,
    avgDurationDays: vol.n >= MIN_SAMPLE ? vol.avg : null,
    medianDurationDays: vol.n >= MIN_SAMPLE ? vol.median : null,
    durationSample: vol.n,
    avgClientWaitHours: wait.client_n >= MIN_SAMPLE ? wait.client_avg : null,
    clientWaitSample: wait.client_n,
    avgStaffWaitHours: wait.staff_n >= MIN_SAMPLE ? wait.staff_avg : null,
    staffWaitSample: wait.staff_n,
    itemsDue: late.due,
    itemsLate: late.late,
    overdueRate: late.due >= MIN_SAMPLE ? Math.round((late.late / late.due) * 100) : null,
    remindersSent: mail.reminders,
    changesRequested: cr.n,
  };
}

/** Requirements that most often ran late or were sent back, within the period. */
export async function delayedRequirements(tx: Tx, p: Period) {
  return tx.q<{ title: string; section_title: string; late: number; total: number; avg_days_late: number | null; sent_back: number }>(
    `with done as (
       select item_id, min(created_at) as at from item_status_history where to_status in ('submitted', 'under_review', 'approved') group by item_id
     ), sent_back as (
       select item_id, count(*)::int as n from item_status_history where to_status = 'changes_requested' and created_at >= $1 and created_at < $2 group by item_id
     )
     select i.title, min(i.section_title) as section_title,
            count(*) filter (where coalesce(d.at, now()) > i.due_at)::int as late,
            count(*)::int as total,
            round(avg(extract(epoch from coalesce(d.at, now()) - i.due_at) / 86400) filter (where coalesce(d.at, now()) > i.due_at)::numeric, 1)::float as avg_days_late,
            coalesce(sum(sb.n), 0)::int as sent_back
     from onboarding_items i left join done d on d.item_id = i.id left join sent_back sb on sb.item_id = i.id
     where i.removed_at is null and i.audience = 'client' and i.due_at >= $1 and i.due_at < least($2, now())
     group by i.title
     having count(*) filter (where coalesce(d.at, now()) > i.due_at) > 0 or coalesce(sum(sb.n), 0) > 0
     order by late desc, sent_back desc limit 10`,
    [p.from, p.to],
  );
}

type LiveItem = ItemLike & { onboarding_id: string; created_at: Date };

async function activeWithItems(tx: Tx) {
  const onbs = await tx.q<{ id: string; status: "active"; owner_user_id: string | null; client_id: string; client_name: string; at_risk: boolean; at_risk_reason: string | null; kickoff_ready_at: Date | null }>(
    `select o.id, o.status, o.owner_user_id, o.client_id, c.name as client_name, o.at_risk, o.at_risk_reason, o.kickoff_ready_at
     from onboardings o join clients c on c.id = o.client_id where o.status = 'active'`,
  );
  const items = onbs.length
    ? await tx.q<LiveItem>("select * from onboarding_items where onboarding_id = any($1) and removed_at is null", [onbs.map((o) => o.id)])
    : [];
  return onbs.map((o) => ({ ...o, items: items.filter((i) => i.onboarding_id === o.id) }));
}

/** Current blockers across active onboardings, grouped by category. */
export async function blockerBreakdown(tx: Tx) {
  const counts = new Map<BlockerCategory, number>();
  for (const o of await activeWithItems(tx)) for (const b of computeBlockers(o, o.items)) counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, count]) => ({ category, label: BLOCKER_LABEL[category], count })).sort((a, b) => b.count - a.count);
}

export async function atRiskClients(tx: Tx) {
  return tx.q<{ client_id: string; client_name: string; reason: string | null; since: Date | null; owner: string | null }>(
    `select c.id as client_id, c.name as client_name, o.at_risk_reason as reason, o.at_risk_at as since, u.name as owner
     from onboardings o join clients c on c.id = o.client_id left join users u on u.id = o.owner_user_id
     where o.status = 'active' and o.at_risk order by o.at_risk_at`,
  );
}

/**
 * Average readiness of active onboardings at weekly points, reconstructed from item status
 * history (what each item's status actually was on that date).
 */
export async function readinessTrend(tx: Tx, p: Period, maxPoints = 12) {
  const onbs = await tx.q<{ id: string; start: Date; end: Date | null }>(
    `select id, start_date::timestamptz as start, coalesce(completed_at, case when status = 'cancelled' then paused_at end) as end
     from onboardings where source <> 'import' and start_date < $2::date and (completed_at is null or completed_at >= $1)`,
    [p.from, p.to],
  );
  if (onbs.length === 0) return [];
  const items = await tx.q<LiveItem & { removed_at: Date | null }>(
    "select * from onboarding_items where onboarding_id = any($1)",
    [onbs.map((o) => o.id)],
  );
  const hist = await tx.q<{ item_id: string; to_status: ItemStatus; created_at: Date }>(
    "select item_id, to_status, created_at from item_status_history where onboarding_id = any($1) order by created_at, id",
    [onbs.map((o) => o.id)],
  );
  const byItem = new Map<string, { to_status: ItemStatus; created_at: Date }[]>();
  for (const h of hist) byItem.set(h.item_id, [...(byItem.get(h.item_id) ?? []), h]);
  const step = Math.max(7 * 86400000, Math.ceil((p.to.getTime() - p.from.getTime()) / maxPoints));
  const points: { date: Date; avg: number | null; onboardings: number }[] = [];
  for (let t = p.from.getTime() + step; t <= Math.min(p.to.getTime(), Date.now()) + 1; t += step) {
    const at = new Date(t);
    const scores: number[] = [];
    for (const o of onbs) {
      if (new Date(o.start) > at || (o.end && new Date(o.end) <= at)) continue;
      const asOf = items
        .filter((i) => i.onboarding_id === o.id && new Date(i.created_at) <= at && (!i.removed_at || new Date(i.removed_at) > at))
        .map((i) => {
          const h = (byItem.get(i.id) ?? []).filter((x) => new Date(x.created_at) <= at).pop();
          return { ...i, removed_at: null, status: h?.to_status ?? "not_started" };
        });
      const r = computeReadiness(asOf, at);
      if (r.score != null) scores.push(r.score);
    }
    points.push({ date: at, avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null, onboardings: scores.length });
  }
  return points;
}

export interface WorkloadRow {
  user_id: string;
  name: string;
  role: string;
  active_onboardings: number;
  reviews_waiting: number;
  oldest_review: Date | null;
  overdue_tasks: number;
  open_tasks: number;
  clients_blocked: number;
  avg_review_hours: number | null;
  reviews_done: number;
}

/** Actual workload per team member. This is a view of assigned work, not a performance score. */
export async function workload(tx: Tx): Promise<WorkloadRow[]> {
  const rows = await tx.q<Omit<WorkloadRow, "clients_blocked">>(
    `select u.id as user_id, u.name, m.role,
       (select count(*)::int from onboardings o where o.owner_user_id = u.id and o.status = 'active') as active_onboardings,
       (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where coalesce(i.reviewer_user_id, i.owner_user_id, o.owner_user_id) = u.id and i.status in ('submitted', 'under_review')
           and i.removed_at is null and o.status = 'active') as reviews_waiting,
       (select min(i.status_changed_at) from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where coalesce(i.reviewer_user_id, i.owner_user_id, o.owner_user_id) = u.id and i.status in ('submitted', 'under_review')
           and i.removed_at is null and o.status = 'active') as oldest_review,
       (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where i.owner_user_id = u.id and i.audience = 'internal' and i.status <> 'approved' and i.removed_at is null
           and o.status = 'active' and i.due_at < now()) as overdue_tasks,
       (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where i.owner_user_id = u.id and i.audience = 'internal' and i.status <> 'approved' and i.removed_at is null and o.status = 'active') as open_tasks,
       (select round(avg(extract(epoch from i.reviewed_at - i.submitted_at) / 3600)::numeric, 1)::float from onboarding_items i
         where i.reviewed_by = u.id and i.reviewed_at > now() - interval '90 days' and i.submitted_at is not null and i.reviewed_at >= i.submitted_at) as avg_review_hours,
       (select count(*)::int from onboarding_items i where i.reviewed_by = u.id and i.reviewed_at > now() - interval '90 days') as reviews_done
     from memberships m join users u on u.id = m.user_id where m.role in ('admin', 'manager', 'staff') order by u.name`,
  );
  const blocked = new Map<string, Set<string>>();
  for (const o of await activeWithItems(tx))
    for (const b of computeBlockers(o, o.items))
      if (b.waitingOn === "staff" && b.ownerUserId) {
        const s = blocked.get(b.ownerUserId) ?? new Set<string>();
        s.add(o.client_id);
        blocked.set(b.ownerUserId, s);
      }
  return rows.map((r) => ({ ...r, clients_blocked: blocked.get(r.user_id)?.size ?? 0, avg_review_hours: r.reviews_done >= MIN_SAMPLE ? r.avg_review_hours : null }));
}

export interface RoiComparison {
  launchedAt: Date | null;
  rows: { label: string; before: number | null; after: number | null; unit: string; better: "lower" | "higher"; beforeSample: number; afterSample: number; note?: string }[];
}

/**
 * Before vs. after ClientFlow, only where both sides have real data. "Before" comes from
 * onboardings completed before the workspace's launch date (for example, imported history).
 */
export async function roiComparison(tx: Tx, launchedAt: Date | null): Promise<RoiComparison> {
  if (!launchedAt) return { launchedAt: null, rows: [] };
  const [d] = await tx.q<{ b_avg: number | null; b_n: number; a_avg: number | null; a_n: number; b_med: number | null; a_med: number | null }>(
    `select
       round(avg(extract(epoch from completed_at - start_date::timestamptz) / 86400) filter (where completed_at < $1)::numeric, 1)::float as b_avg,
       count(*) filter (where completed_at < $1)::int as b_n,
       round(avg(extract(epoch from completed_at - start_date::timestamptz) / 86400) filter (where start_date >= $1::date)::numeric, 1)::float as a_avg,
       count(*) filter (where start_date >= $1::date)::int as a_n,
       round((percentile_cont(0.5) within group (order by extract(epoch from completed_at - start_date::timestamptz) / 86400) filter (where completed_at < $1))::numeric, 1)::float as b_med,
       round((percentile_cont(0.5) within group (order by extract(epoch from completed_at - start_date::timestamptz) / 86400) filter (where start_date >= $1::date))::numeric, 1)::float as a_med
     from onboardings where status = 'completed' and completed_at is not null`,
    [launchedAt],
  );
  const [r] = await tx.q<{ auto: number; manual: number }>(
    `select count(*) filter (where kind in ('reminder', 'automation') and status in ('sent', 'simulated'))::int as auto,
            0::int as manual from email_messages where created_at >= $1`,
    [launchedAt],
  );
  const [rev] = await tx.q<{ a_avg: number | null; a_n: number }>(
    `select round(avg(extract(epoch from reviewed_at - submitted_at) / 3600)::numeric, 1)::float as a_avg, count(*)::int as a_n
     from onboarding_items where reviewed_at >= $1 and submitted_at is not null and reviewed_at >= submitted_at`,
    [launchedAt],
  );
  const ok = (n: number) => n >= MIN_SAMPLE;
  return {
    launchedAt,
    rows: [
      { label: "Average onboarding duration", before: ok(d.b_n) ? d.b_avg : null, after: ok(d.a_n) ? d.a_avg : null, unit: "days", better: "lower", beforeSample: d.b_n, afterSample: d.a_n },
      { label: "Median onboarding duration", before: ok(d.b_n) ? d.b_med : null, after: ok(d.a_n) ? d.a_med : null, unit: "days", better: "lower", beforeSample: d.b_n, afterSample: d.a_n },
      {
        label: "Staff review delay",
        before: null,
        after: ok(rev.a_n) ? rev.a_avg : null,
        unit: "hours",
        better: "lower",
        beforeSample: 0,
        afterSample: rev.a_n,
        note: "Review timing wasn't recorded before ClientFlow, so there is no baseline.",
      },
      {
        label: "Reminders sent automatically",
        before: null,
        after: r.auto,
        unit: "emails",
        better: "higher",
        beforeSample: 0,
        afterSample: r.auto,
        note: "A count of automated follow-ups, not an estimate of time saved.",
      },
    ],
  };
}
