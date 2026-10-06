import type { Tx } from "./db";

/** All metrics are computed from stored records. Nothing is estimated or extrapolated. */
export async function getReports(tx: Tx) {
  const [duration] = await tx.q<{ completed: number; avg_days: number | null; median_days: number | null; min_days: number | null; max_days: number | null }>(
    `select count(*)::int as completed,
            round(avg(extract(epoch from completed_at - created_at) / 86400)::numeric, 1)::float as avg_days,
            round((percentile_cont(0.5) within group (order by extract(epoch from completed_at - created_at) / 86400))::numeric, 1)::float as median_days,
            round(min(extract(epoch from completed_at - created_at) / 86400)::numeric, 1)::float as min_days,
            round(max(extract(epoch from completed_at - created_at) / 86400)::numeric, 1)::float as max_days
     from onboardings where status = 'completed' and completed_at is not null`,
  );

  const overdueByClient = await tx.q<{ client_id: string; client_name: string; overdue: number; oldest_due: Date }>(
    `select c.id as client_id, c.name as client_name, count(*)::int as overdue, min(i.due_at) as oldest_due
     from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
     where o.status = 'active' and i.due_at < now() and i.status in ('not_started', 'in_progress', 'changes_requested')
     group by c.id, c.name order by overdue desc, oldest_due limit 10`,
  );

  const [overdueTotals] = await tx.q<{ client_side: number; staff_side: number }>(
    `select count(*) filter (where i.audience = 'client')::int as client_side,
            count(*) filter (where i.audience = 'internal')::int as staff_side
     from onboarding_items i join onboardings o on o.id = i.onboarding_id
     where o.status = 'active' and i.due_at < now() and i.status in ('not_started', 'in_progress', 'changes_requested')`,
  );

  // Common blockers: items (by template item) that most often are overdue or had changes requested.
  const commonBlockers = await tx.q<{ title: string; section_title: string; overdue_now: number; changes_requested_events: number; onboardings: number }>(
    `with req as (
       select i.item_key, count(*)::int as n from audit_events a join onboarding_items i on i.id = a.entity_id
       where a.action = 'item.changes_requested' group by i.item_key
     )
     select i.title, i.section_title,
            count(*) filter (where i.due_at < now() and i.status in ('not_started','in_progress','changes_requested') and o.status = 'active')::int as overdue_now,
            coalesce(max(req.n), 0)::int as changes_requested_events,
            count(distinct i.onboarding_id)::int as onboardings
     from onboarding_items i join onboardings o on o.id = i.onboarding_id left join req on req.item_key = i.item_key
     group by i.item_key, i.title, i.section_title
     having count(*) filter (where i.due_at < now() and i.status in ('not_started','in_progress','changes_requested') and o.status = 'active') > 0
         or coalesce(max(req.n), 0) > 0
     order by (count(*) filter (where i.due_at < now() and i.status in ('not_started','in_progress','changes_requested') and o.status = 'active') + coalesce(max(req.n), 0)) desc
     limit 8`,
  );

  const workload = await tx.q<{ user_id: string; name: string; open_tasks: number; overdue_tasks: number; reviews_waiting: number; active_onboardings: number }>(
    `select u.id as user_id, u.name,
            (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
              where i.owner_user_id = u.id and i.audience = 'internal' and i.status <> 'approved' and o.status = 'active') as open_tasks,
            (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
              where i.owner_user_id = u.id and i.audience = 'internal' and i.status <> 'approved' and o.status = 'active' and i.due_at < now()) as overdue_tasks,
            (select count(*)::int from onboarding_items i join onboardings o on o.id = i.onboarding_id
              where o.owner_user_id = u.id and i.status = 'submitted' and o.status = 'active') as reviews_waiting,
            (select count(*)::int from onboardings o where o.owner_user_id = u.id and o.status = 'active') as active_onboardings
     from memberships m join users u on u.id = m.user_id where m.role in ('admin', 'staff') order by u.name`,
  );

  const [reviewTurnaround] = await tx.q<{ reviews: number; avg_hours: number | null }>(
    `select count(*)::int as reviews,
            round(avg(extract(epoch from reviewed_at - submitted_at) / 3600)::numeric, 1)::float as avg_hours
     from onboarding_items where reviewed_at is not null and submitted_at is not null and reviewed_at >= submitted_at`,
  );

  const [counts] = await tx.q<{ active: number; paused: number; completed: number }>(
    `select count(*) filter (where status = 'active')::int as active, count(*) filter (where status = 'paused')::int as paused,
            count(*) filter (where status = 'completed')::int as completed from onboardings`,
  );

  return { duration, overdueByClient, overdueTotals, commonBlockers, workload, reviewTurnaround, counts };
}
