import Link from "next/link";
import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames, type ItemRow } from "@/lib/queries";
import { isOverdue, unmetDependencies, type ItemLike } from "@/lib/onboarding";
import { SENSITIVE_CATEGORIES } from "@/lib/templates";
import { can } from "@/lib/permissions";
import { formatDate, formatDateTime } from "@/lib/time";
import { Avatar, Badge, EmptyState, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KindIcon, KIND_LABEL } from "@/components/kind";
import { addCommentAction, reassignReviewerAction, reviewItemAction, setTaskStatusAction, startReviewAction } from "../actions";

export const metadata = { title: "Tasks" };

interface QueueRow {
  id: string;
  title: string;
  kind: string;
  status: "submitted" | "under_review" | "changes_requested";
  category: string | null;
  critical: boolean;
  due_at: Date | null;
  status_changed_at: Date;
  reviewer_user_id: string | null;
  owner_user_id: string | null;
  client_id: string;
  client_name: string;
  onboarding_id: string;
  doc_count: number;
  pending_docs: number;
}

const DAY = 86400000;

function age(since: Date) {
  const ms = Date.now() - new Date(since).getTime();
  const days = Math.floor(ms / DAY);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor(ms / 3600000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string; who?: string; show?: string; status?: string }> }) {
  const auth = await requireStaff();
  const sp = await searchParams;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const queue = await tx.q<QueueRow>(
      `select i.id, i.title, i.kind, i.status, i.category, i.critical, i.due_at, i.status_changed_at, i.reviewer_user_id, i.owner_user_id,
              i.client_id, c.name as client_name, i.onboarding_id,
              (select count(*)::int from documents d where d.item_id = i.id) as doc_count,
              (select count(*)::int from (select distinct on (v.document_id) v.review_status from document_versions v join documents d on d.id = v.document_id
                 where d.item_id = i.id order by v.document_id, v.version desc) l where l.review_status = 'pending') as pending_docs
       from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
       where o.status = 'active' and i.removed_at is null and i.audience = 'client' and i.status in ('submitted', 'under_review', 'changes_requested')
       order by i.status_changed_at asc`,
    );
    const tasks = await tx.q<ItemRow & { client_name: string }>(
      `select i.*, c.name as client_name from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
       where i.audience = 'internal' and o.status = 'active' and i.removed_at is null
       order by (i.status <> 'approved' and i.due_at < now()) desc, i.due_at nulls last, c.name`,
    );
    const siblings = tasks.length
      ? await tx.q<ItemRow>("select * from onboarding_items where onboarding_id = any($1) and removed_at is null", [[...new Set(tasks.map((t) => t.onboarding_id))]])
      : [];
    return { queue, tasks, siblings, staff: await staffNames(tx) };
  });

  const awaiting = data.queue.filter((q) => q.status !== "changes_requested");
  const tab = sp.tab === "tasks" || sp.tab === "review" ? sp.tab : awaiting.length > 0 ? "review" : "tasks";
  const who = sp.who ?? (tab === "review" ? "all" : "mine");
  const show = sp.show ?? "open";
  const names = data.staff.map;
  const myOpenTasks = data.tasks.filter((t) => t.owner_user_id === auth.user.id && t.status !== "approved").length;

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          awaiting.length > 0
            ? `${awaiting.length} client submission${awaiting.length === 1 ? "" : "s"} awaiting staff review.`
            : "No client submissions are waiting for staff review."
        }
      />
      <div className="mb-5">
        <Tabs
          active={tab}
          tabs={[
            { key: "review", label: `Review queue${awaiting.length ? ` (${awaiting.length})` : ""}`, href: "/app/tasks?tab=review" },
            { key: "tasks", label: `Tasks${myOpenTasks ? ` (${myOpenTasks} mine)` : ""}`, href: "/app/tasks?tab=tasks" },
          ]}
        />
      </div>
      {tab === "review" ? (
        <ReviewQueue rows={data.queue} who={who} status={sp.status ?? "waiting"} meId={auth.user.id} names={names} staffList={data.staff.list} canApprove={auth.canApprove} canReassign={can(auth.role, "reassignReviews")} />
      ) : (
        <TaskList tasks={data.tasks} siblings={data.siblings} who={who} show={show} meId={auth.user.id} names={names} staffList={data.staff.list} />
      )}
    </>
  );
}

function FilterPills({ base, who, extra, staffList, hidden }: { base: string; who: string; extra: string; staffList: { id: string; name: string }[]; hidden: Record<string, string> }) {
  const filters = [
    ["mine", "Mine"],
    ["all", "All"],
    ["unassigned", "Unassigned"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {filters.map(([k, label]) => (
        <Link
          key={k}
          href={`${base}&who=${k}${extra}`}
          className={clsx("rounded-full px-3 py-1.5 text-sm font-medium", who === k ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50")}
        >
          {label}
        </Link>
      ))}
      <form className="ml-1 flex items-center" action="/app/tasks">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <select name="who" defaultValue={filters.some(([k]) => k === who) ? "" : who} className="input w-auto py-1.5 text-sm" aria-label="Filter by person">
          <option value="">Person…</option>
          {staffList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn-ghost ml-1 px-2 py-1 text-sm">Go</button>
      </form>
    </div>
  );
}

function ReviewQueue({
  rows,
  who,
  status,
  meId,
  names,
  staffList,
  canApprove,
  canReassign,
}: {
  rows: QueueRow[];
  who: string;
  status: string;
  meId: string;
  names: Map<string, string>;
  staffList: { id: string; name: string }[];
  canApprove: boolean;
  canReassign: boolean;
}) {
  const filtered = rows.filter((r) => {
    if (status === "waiting" && r.status === "changes_requested") return false;
    if (status === "changes" && r.status !== "changes_requested") return false;
    if (who === "mine") return r.reviewer_user_id === meId;
    if (who === "unassigned") return !r.reviewer_user_id;
    if (who !== "all") return r.reviewer_user_id === who;
    return true;
  });
  const statusTabs = [
    ["waiting", "Awaiting review"],
    ["changes", "Changes requested"],
    ["all", "Everything"],
  ];
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterPills base="/app/tasks?tab=review" who={who} extra={`&status=${status}`} staffList={staffList} hidden={{ tab: "review", status }} />
        <div className="flex flex-wrap gap-1 text-sm">
          {statusTabs.map(([k, label]) => (
            <Link key={k} href={`/app/tasks?tab=review&who=${who}&status=${k}`} className={clsx("rounded-md px-2.5 py-1", status === k ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100")}>
              {label}
            </Link>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title={status === "changes" ? "Nothing sent back" : "Review queue is clear"}
          description={who === "mine" ? "Nothing is assigned to you for review. Try All or Unassigned." : "No matching client submissions."}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_90px_80px_130px] gap-4 border-b border-ink-100 bg-ink-50/60 px-5 py-2.5 lg:grid">
            {["Item", "Client", "Reviewer", "Age", "Priority", "Status"].map((h) => (
              <span key={h} className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                {h}
              </span>
            ))}
          </div>
          <ul className="divide-y divide-ink-100">
            {filtered.map((r) => {
              const overdue = !!r.due_at && new Date(r.due_at).getTime() < Date.now();
              const high = r.critical || overdue;
              const reviewer = r.reviewer_user_id ? names.get(r.reviewer_user_id) ?? "Former member" : null;
              const href = `/app/clients/${r.client_id}/items/${r.id}`;
              const waiting = r.status !== "changes_requested";
              const sensitive = !!r.category && SENSITIVE_CATEGORIES.has(r.category);
              return (
                <li key={r.id} className="px-5 py-4 hover:bg-ink-50/50">
                  <div className="grid gap-2 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_90px_80px_130px] lg:items-center lg:gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <KindIcon kind={r.kind} />
                      <div className="min-w-0">
                        <Link href={href} className="block truncate font-medium text-ink-900 hover:text-brand-700">
                          {r.title}
                        </Link>
                        <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                          {KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind}
                          {r.doc_count > 0 && <span>· {r.doc_count} file{r.doc_count === 1 ? "" : "s"}</span>}
                          {sensitive && <span className="text-amber-700">· {r.category}, human review</span>}
                        </p>
                      </div>
                    </div>
                    <Link href={`/app/clients/${r.client_id}`} className="truncate pl-9 text-sm text-ink-700 hover:text-brand-700 lg:pl-0">
                      {r.client_name}
                    </Link>
                    <span className="flex min-w-0 items-center gap-2 pl-9 text-sm lg:pl-0">
                      {reviewer ? (
                        <>
                          <Avatar name={reviewer} />
                          <span className="truncate">{reviewer}</span>
                        </>
                      ) : (
                        <Badge tone="warning">Unassigned</Badge>
                      )}
                    </span>
                    <span className="pl-9 text-sm text-ink-600 lg:pl-0" title={`Since ${formatDateTime(r.status_changed_at)}`}>
                      {age(r.status_changed_at)}
                    </span>
                    <span className="pl-9 lg:pl-0">
                      {high ? (
                        <Badge tone="danger" className="">
                          High
                        </Badge>
                      ) : (
                        <Badge>Normal</Badge>
                      )}
                    </span>
                    <span className="pl-9 lg:pl-0">
                      <StatusBadge status={r.status} />
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-start gap-2 pl-9">
                    {r.status === "submitted" && (
                      <ActionForm action={startReviewAction} showSuccess={false}>
                        <input type="hidden" name="itemId" value={r.id} />
                        <SubmitButton className="btn-secondary px-2.5 py-1 text-xs">Start review</SubmitButton>
                      </ActionForm>
                    )}
                    {waiting && canApprove && (
                      <ActionForm
                        action={reviewItemAction}
                        showSuccess={false}
                        confirm={r.kind === "file" && r.pending_docs > 0 ? `Approve "${r.title}" and accept ${r.pending_docs} pending file${r.pending_docs === 1 ? "" : "s"}?` : undefined}
                      >
                        <input type="hidden" name="itemId" value={r.id} />
                        <input type="hidden" name="decision" value="approve" />
                        <SubmitButton className="btn-primary px-2.5 py-1 text-xs">Approve</SubmitButton>
                      </ActionForm>
                    )}
                    {waiting && canApprove && (
                      <Popover label="Request changes">
                        <ActionForm action={reviewItemAction} className="space-y-2">
                          <input type="hidden" name="itemId" value={r.id} />
                          <input type="hidden" name="decision" value="changes" />
                          <textarea name="note" className="input min-h-[70px] text-sm" placeholder="What should the client change? (visible to the client)" required />
                          <SubmitButton className="btn-danger w-full px-3 py-1.5 text-xs">Send back to client</SubmitButton>
                        </ActionForm>
                      </Popover>
                    )}
                    <Popover label="Comment">
                      <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2">
                        <input type="hidden" name="onboardingId" value={r.onboarding_id} />
                        <input type="hidden" name="itemId" value={r.id} />
                        <textarea name="body" className="input min-h-[70px] text-sm" required />
                        <select name="visibility" className="input py-1.5 text-sm" defaultValue="internal" aria-label="Visibility">
                          <option value="internal">Internal note (team only)</option>
                          <option value="client">Visible to client</option>
                        </select>
                        <SubmitButton className="btn-primary w-full px-3 py-1.5 text-xs">Post</SubmitButton>
                      </ActionForm>
                    </Popover>
                    {canReassign && (
                      <Popover label="Reassign reviewer">
                        <ActionForm action={reassignReviewerAction} className="space-y-2">
                          <input type="hidden" name="itemId" value={r.id} />
                          <select name="reviewerId" className="input py-1.5 text-sm" defaultValue={r.reviewer_user_id ?? ""} aria-label="Reviewer">
                            <option value="">Unassigned</option>
                            {staffList.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                          <SubmitButton className="btn-primary w-full px-3 py-1.5 text-xs">Reassign and notify</SubmitButton>
                        </ActionForm>
                      </Popover>
                    )}
                    <Link href={href} className="btn-ghost px-2.5 py-1 text-xs">
                      Open item
                    </Link>
                    <Link href={`/app/clients/${r.client_id}`} className="btn-ghost px-2.5 py-1 text-xs">
                      Open client <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!canApprove && <p className="mt-3 text-xs text-ink-500">You don't have approval permission, so Approve and Request changes are hidden. You can still comment and reassign.</p>}
    </>
  );
}

function Popover({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="relative">
      <summary className="btn-secondary cursor-pointer list-none px-2.5 py-1 text-xs">{label}</summary>
      <div className="absolute left-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-ink-200 bg-white p-3 shadow-lg">{children}</div>
    </details>
  );
}

function TaskList({
  tasks,
  siblings,
  who,
  show,
  meId,
  names,
  staffList,
}: {
  tasks: (ItemRow & { client_name: string })[];
  siblings: ItemRow[];
  who: string;
  show: string;
  meId: string;
  names: Map<string, string>;
  staffList: { id: string; name: string }[];
}) {
  const byOnb = new Map<string, Map<string, ItemLike>>();
  for (const s of siblings) {
    const m = byOnb.get(s.onboarding_id) ?? new Map<string, ItemLike>();
    m.set(s.item_key, s);
    byOnb.set(s.onboarding_id, m);
  }
  const filtered = tasks.filter((t) => {
    if (show === "open" && t.status === "approved") return false;
    if (who === "mine") return t.owner_user_id === meId;
    if (who === "unassigned") return !t.owner_user_id;
    if (who !== "all") return t.owner_user_id === who;
    return true;
  });
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterPills base="/app/tasks?tab=tasks" who={who} extra={`&show=${show}`} staffList={staffList} hidden={{ tab: "tasks", show }} />
        <Link href={`/app/tasks?tab=tasks&who=${who}&show=${show === "open" ? "all" : "open"}`} className="text-sm link">
          {show === "open" ? "Show completed" : "Hide completed"}
        </Link>
      </div>
      <p className="mb-3 text-sm text-ink-500">Internal work across active onboardings, overdue first. Clients never see these.</p>
      {filtered.length === 0 ? (
        <EmptyState title="No tasks here" description={who === "mine" ? "Nothing is assigned to you right now." : "No matching tasks."} />
      ) : (
        <div className="card divide-y divide-ink-100">
          {filtered.map((t) => {
            const unmet = unmetDependencies(t, byOnb.get(t.onboarding_id) ?? new Map());
            const overdue = isOverdue(t);
            const owner = t.owner_user_id ? names.get(t.owner_user_id) : null;
            return (
              <div key={t.id} className="flex flex-col gap-3 px-5 py-4 hover:bg-ink-50/50 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <Link href={`/app/clients/${t.client_id}/items/${t.id}`} className="font-medium text-ink-900 hover:text-brand-700">
                    {t.title}
                  </Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    <Link href={`/app/clients/${t.client_id}`} className="hover:text-ink-800">
                      {t.client_name}
                    </Link>
                    {t.due_at && t.status !== "approved" && (
                      <span className={overdue ? "font-medium text-rose-700" : ""}>
                        {overdue ? "Overdue · " : "Due "}
                        {formatDate(t.due_at)}
                      </span>
                    )}
                    {t.critical && <Badge tone="danger">Critical</Badge>}
                    {unmet.length > 0 && <span className="text-amber-700">Blocked by {unmet.map((u) => u.title).join(", ")}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {owner ? (
                    <span title={owner}>
                      <Avatar name={owner} />
                    </span>
                  ) : (
                    <Badge tone="warning">Unassigned</Badge>
                  )}
                  <StatusBadge status={unmet.length && t.status !== "approved" ? "blocked" : t.status} task />
                  {t.status !== "approved" && (
                    <ActionForm action={setTaskStatusAction} showSuccess={false} className="flex gap-1">
                      <input type="hidden" name="itemId" value={t.id} />
                      {t.status === "not_started" && (
                        <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" name="status" value="in_progress">
                          Start
                        </SubmitButton>
                      )}
                      <SubmitButton
                        className="btn-secondary px-2.5 py-1 text-xs"
                        name="status"
                        value="approved"
                        disabled={unmet.length > 0}
                        title={unmet.length ? "Finish dependencies first" : undefined}
                      >
                        Mark done
                      </SubmitButton>
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
