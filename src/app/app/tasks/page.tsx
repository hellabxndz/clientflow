import Link from "next/link";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames, type ItemRow } from "@/lib/queries";
import { isOverdue, unmetDependencies } from "@/lib/onboarding";
import { Avatar, Badge, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate } from "@/lib/time";
import { setTaskStatusAction } from "../actions";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ who?: string; show?: string }> }) {
  const auth = await requireStaff();
  const { who = "mine", show = "open" } = await searchParams;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const tasks = await tx.q<ItemRow & { client_name: string }>(
      `select i.*, c.name as client_name from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
       where i.audience = 'internal' and o.status = 'active'
         and ($1 = 'all' or ($1 = 'unassigned' and i.owner_user_id is null) or i.owner_user_id::text = $1 or ($1 = 'mine' and i.owner_user_id = $2))
         and ($3 = 'all' or i.status <> 'approved')
       order by i.due_at nulls last, c.name`,
      [who, auth.user.id, show],
    );
    const siblings = tasks.length
      ? await tx.q<ItemRow>("select * from onboarding_items where onboarding_id = any($1)", [[...new Set(tasks.map((t) => t.onboarding_id))]])
      : [];
    return { tasks, siblings, staff: await staffNames(tx) };
  });
  const byOnb = new Map<string, Map<string, ItemRow>>();
  for (const s of data.siblings) {
    const m = byOnb.get(s.onboarding_id) ?? new Map();
    m.set(s.item_key, s);
    byOnb.set(s.onboarding_id, m);
  }
  const filters = [
    ["mine", "Assigned to me"],
    ["all", "Everyone"],
    ["unassigned", "Unassigned"],
  ];

  return (
    <>
      <PageHeader title="Tasks" description="Internal work across active onboardings. Clients never see these." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {filters.map(([k, label]) => (
            <Link key={k} href={`/app/tasks?who=${k}&show=${show}`} className={clsx("rounded-full px-3 py-1.5 text-sm font-medium", who === k ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200")}>{label}</Link>
          ))}
          <form className="ml-1">
            <input type="hidden" name="show" value={show} />
            <select name="who" defaultValue={filters.some(([k]) => k === who) ? "" : who} className="input w-auto py-1.5 text-sm" aria-label="Filter by owner">
              <option value="">Owner…</option>
              {data.staff.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn-ghost ml-1 px-2 py-1 text-sm">Go</button>
          </form>
        </div>
        <Link href={`/app/tasks?who=${who}&show=${show === "open" ? "all" : "open"}`} className="text-sm link">{show === "open" ? "Show completed" : "Hide completed"}</Link>
      </div>

      {data.tasks.length === 0 ? (
        <EmptyState title="No tasks here" description={who === "mine" ? "Nothing is assigned to you right now." : "No matching tasks."} />
      ) : (
        <div className="card divide-y divide-ink-100">
          {data.tasks.map((t) => {
            const unmet = unmetDependencies(t, byOnb.get(t.onboarding_id) ?? new Map());
            const overdue = isOverdue(t);
            return (
              <div key={t.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <Link href={`/app/clients/${t.client_id}/items/${t.id}`} className="font-medium text-ink-900 hover:text-brand-700">{t.title}</Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    <span>{t.client_name}</span>
                    {t.due_at && <span className={overdue ? "font-medium text-rose-700" : ""}>{overdue ? "Overdue · " : "Due "}{formatDate(t.due_at)}</span>}
                    {unmet.length > 0 && <span className="text-amber-700">Blocked by {unmet.map((u) => u.title).join(", ")}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {t.owner_user_id ? <span title={data.staff.map.get(t.owner_user_id)}><Avatar name={data.staff.map.get(t.owner_user_id) ?? "?"} /></span> : <Badge tone="warning">Unassigned</Badge>}
                  <StatusBadge status={t.status} task />
                  {t.status !== "approved" && (
                    <ActionForm action={setTaskStatusAction} showSuccess={false} className="flex gap-1">
                      <input type="hidden" name="itemId" value={t.id} />
                      {t.status === "not_started" && <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" name="status" value="in_progress">Start</SubmitButton>}
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" name="status" value="approved" disabled={unmet.length > 0} title={unmet.length ? "Finish dependencies first" : undefined}>Done</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
