import Link from "next/link";
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { formatMoney, loadOnboardings, staffNames, type LoadedOnboarding } from "@/lib/queries";
import { isOverdue, STAGE_LABEL, type Stage } from "@/lib/onboarding";
import { AtRiskBadge, Badge, EmptyState, PageHeader, Progress, ReadinessPill, StageBadge, WaitingOnBadge } from "@/components/ui";
import { formatDate } from "@/lib/time";

export const metadata = { title: "Clients" };

type Params = { q?: string; stage?: string; waiting?: string; risk?: string; overdue?: string; owner?: string; type?: string; archived?: string; status?: string };

interface ClientRow {
  id: string;
  name: string;
  industry: string | null;
  primary_contact_name: string | null;
  client_type_id: string | null;
  client_type_name: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  deal_amount: string | null;
  deal_recurrence: "one_time" | "monthly" | "annual";
  archived_at: Date | null;
}

const STAGES: Stage[] = ["waiting_client", "review", "internal", "ready", "paused", "completed"];
const KICKOFF_BASIS = { scheduled: "Scheduled", ready: "Earliest", estimate: "Estimate", none: "" } as const;

const overdueCount = (o: LoadedOnboarding) =>
  o.status === "active" ? o.items.filter((i) => !i.removed_at && i.audience === "client" && i.required && isOverdue(i)).length : 0;

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requireStaff();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const stage = STAGES.includes(sp.stage as Stage) ? (sp.stage as Stage) : "";
  const waiting = sp.waiting === "client" || sp.waiting === "staff" ? sp.waiting : "";
  const risk = sp.risk === "1";
  const overdue = sp.overdue === "1";
  const archived = sp.archived === "1";
  const activeOnly = sp.status === "active";
  const owner = sp.owner ?? "";
  const type = sp.type ?? "";

  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const clients = await tx.q<ClientRow>(
      `select c.id, c.name, c.industry, c.primary_contact_name, c.client_type_id, ct.name as client_type_name, c.owner_user_id,
              u.name as owner_name, c.deal_amount::text, c.deal_recurrence, c.archived_at
       from clients c left join client_types ct on ct.id = c.client_type_id left join users u on u.id = c.owner_user_id
       where ($1 = '' or c.name ilike '%' || $1 || '%') and (($2::boolean and c.archived_at is not null) or (not $2::boolean and c.archived_at is null))
       order by c.name`,
      [q, archived],
    );
    const onboardings = await loadOnboardings(tx, "o.status <> 'cancelled'", [], {
      leadDays: auth.workspace.kickoff_lead_days,
      businessDays: auth.workspace.business_days,
    });
    const types = await tx.q<{ id: string; name: string }>("select id, name from client_types order by position, name");
    return { clients, onboardings, types, staff: (await staffNames(tx)).list };
  });

  // Latest onboarding per client (loadOnboardings orders newest first); an in-progress one wins over a newer completed one.
  const latest = new Map<string, LoadedOnboarding>();
  for (const o of data.onboardings) {
    const cur = latest.get(o.client_id);
    const live = (x: LoadedOnboarding) => x.status === "active" || x.status === "paused";
    if (!cur || (!live(cur) && live(o))) latest.set(o.client_id, o);
  }

  const base = data.clients
    .map((c) => ({ client: c, o: latest.get(c.id) }))
    .filter(({ client }) => !type || client.client_type_id === type)
    .filter(({ client, o }) => !owner || (o?.owner_user_id ?? client.owner_user_id) === owner);

  const match = {
    stage: (r: (typeof base)[number], s: Stage) => r.o?.state.stage === s,
    waiting: (r: (typeof base)[number], w: string) => r.o?.state.waitingOn === w,
    risk: (r: (typeof base)[number]) => !!r.o && r.o.status !== "completed" && r.o.state.atRisk,
    overdue: (r: (typeof base)[number]) => !!r.o && overdueCount(r.o) > 0,
    active: (r: (typeof base)[number]) => r.o?.status === "active",
  };

  const rows = base.filter(
    (r) =>
      (!stage || match.stage(r, stage)) &&
      (!waiting || match.waiting(r, waiting)) &&
      (!risk || match.risk(r)) &&
      (!overdue || match.overdue(r)) &&
      (!activeOnly || match.active(r)),
  );

  const current: Params = { q, stage, waiting, risk: risk ? "1" : "", overdue: overdue ? "1" : "", owner, type, archived: archived ? "1" : "", status: activeOnly ? "active" : "" };
  const href = (patch: Partial<Params>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/app/clients?${s}` : "/app/clients";
  };
  const anyFilter = !!(q || stage || waiting || risk || overdue || owner || type || activeOnly);

  const stageChips = STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s], count: base.filter((r) => match.stage(r, s)).length }));
  const toggles = [
    { label: "Active", on: activeOnly, count: base.filter(match.active).length, href: href({ status: activeOnly ? "" : "active" }) },
    { label: "Waiting on Client", on: waiting === "client", count: base.filter((r) => match.waiting(r, "client")).length, href: href({ waiting: waiting === "client" ? "" : "client" }) },
    { label: "Waiting on Staff", on: waiting === "staff", count: base.filter((r) => match.waiting(r, "staff")).length, href: href({ waiting: waiting === "staff" ? "" : "staff" }) },
    { label: "Overdue requests", on: overdue, count: base.filter(match.overdue).length, href: href({ overdue: overdue ? "" : "1" }) },
    { label: "At Risk", on: risk, count: base.filter(match.risk).length, href: href({ risk: risk ? "" : "1" }) },
  ];

  return (
    <>
      <PageHeader
        title={archived ? "Archived clients" : "Clients"}
        description={archived ? "Clients that were archived. They are hidden from the main list and dashboard." : "Every client, their latest onboarding, and what it is waiting on."}
        actions={
          <>
            <Link href={archived ? "/app/clients" : "/app/clients?archived=1"} className="btn-secondary">
              {archived ? "Back to clients" : "Archived"}
            </Link>
            <Link href="/app/clients/new" className="btn-primary">New client</Link>
          </>
        }
      />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Chip href={href({ stage: "" })} on={!stage} label="All stages" count={base.length} />
          {stageChips.map((c) => (
            <Chip key={c.key} href={href({ stage: stage === c.key ? "" : c.key })} on={stage === c.key} label={c.label} count={c.count} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {toggles.map((t) => (
            <Chip key={t.label} href={t.href} on={t.on} label={t.label} count={t.count} subtle />
          ))}
        </div>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {stage && <input type="hidden" name="stage" value={stage} />}
          {waiting && <input type="hidden" name="waiting" value={waiting} />}
          {risk && <input type="hidden" name="risk" value="1" />}
          {overdue && <input type="hidden" name="overdue" value="1" />}
          {archived && <input type="hidden" name="archived" value="1" />}
          {activeOnly && <input type="hidden" name="status" value="active" />}
          <div className="relative min-w-0 sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input name="q" defaultValue={q} placeholder="Search by name" className="input pl-9" aria-label="Search clients" />
          </div>
          <select name="owner" defaultValue={owner} className="input sm:w-48" aria-label="Owner">
            <option value="">Any owner</option>
            {data.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select name="type" defaultValue={type} className="input sm:w-48" aria-label="Client type">
            <option value="">Any client type</option>
            {data.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn-secondary">Apply</button>
          {anyFilter && (
            <Link href={archived ? "/app/clients?archived=1" : "/app/clients"} className="inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-800 sm:ml-1">
              <X className="h-4 w-4" /> Clear filters
            </Link>
          )}
        </form>
        <p className="text-sm text-ink-500">
          Showing {rows.length} of {data.clients.length} {archived ? "archived " : ""}client{data.clients.length === 1 ? "" : "s"}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={anyFilter ? "No clients match these filters" : archived ? "No archived clients" : "No clients yet"}
          description={anyFilter ? "Try removing a filter." : archived ? "Archived clients will appear here." : "Add a client to start their onboarding."}
          action={
            anyFilter ? (
              <Link href={archived ? "/app/clients?archived=1" : "/app/clients"} className="btn-secondary">Clear filters</Link>
            ) : archived ? undefined : (
              <Link href="/app/clients/new" className="btn-primary">New client</Link>
            )
          }
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[980px]">
            <thead className="border-b border-ink-100 bg-ink-50/60">
              <tr>
                <th className="table-head">Client</th>
                <th className="table-head">Owner</th>
                <th className="table-head w-44">Readiness</th>
                <th className="table-head">Stage</th>
                <th className="table-head">Blocked</th>
                <th className="table-head">Projected kickoff</th>
                <th className="table-head text-right">Contract value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map(({ client, o }) => {
                const od = o ? overdueCount(o) : 0;
                return (
                  <tr key={client.id} className="hover:bg-ink-50">
                    <td className="table-cell max-w-[260px]">
                      <div className="flex items-center gap-2">
                        <Link href={`/app/clients/${client.id}`} className="truncate font-medium text-ink-900 hover:text-brand-700">{client.name}</Link>
                        {o?.state.atRisk && o.status !== "completed" && <AtRiskBadge />}
                      </div>
                      <p className="truncate text-xs text-ink-500">{[client.client_type_name, client.industry].filter(Boolean).join(" · ") || "No client type"}</p>
                    </td>
                    <td className="table-cell whitespace-nowrap text-sm text-ink-600">{o?.owner_name ?? client.owner_name ?? <span className="text-ink-400">Unassigned</span>}</td>
                    <td className="table-cell">
                      {o ? (
                        <div className="space-y-1.5">
                          <ReadinessPill score={o.state.readiness.score} />
                          <Progress value={o.state.readiness.score ?? 0} className="h-1.5" />
                        </div>
                      ) : (
                        <span className="text-xs text-ink-400">–</span>
                      )}
                    </td>
                    <td className="table-cell">
                      {o ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <StageBadge stage={o.state.stage} />
                          {o.state.waitingOn && o.state.stage !== (o.state.waitingOn === "client" ? "waiting_client" : "review") && <WaitingOnBadge waitingOn={o.state.waitingOn} />}
                          {od > 0 && <Badge tone="danger">{od} overdue</Badge>}
                        </div>
                      ) : (
                        <Badge>No onboarding</Badge>
                      )}
                      {o?.status === "completed" && <p className="mt-1 text-xs text-ink-500">Completed {formatDate(o.completed_at)}</p>}
                    </td>
                    <td className="table-cell whitespace-nowrap text-sm">
                      {o && o.state.blockers.length > 0 && o.status === "active" ? (
                        <span className={clsx("font-medium", o.state.blockedDays >= 7 ? "text-rose-700" : o.state.blockedDays >= 3 ? "text-amber-700" : "text-ink-700")}>
                          {o.state.blockedDays === 0 ? "Today" : `${o.state.blockedDays} day${o.state.blockedDays === 1 ? "" : "s"}`}
                        </span>
                      ) : (
                        <span className="text-ink-400">–</span>
                      )}
                    </td>
                    <td className="table-cell whitespace-nowrap text-sm" title={o?.kickoff.note || undefined}>
                      {o?.kickoff.date ? (
                        <>
                          <span className="text-ink-800">{formatDate(o.kickoff.date)}</span>
                          <span className="block text-xs text-ink-500">{KICKOFF_BASIS[o.kickoff.basis]}</span>
                        </>
                      ) : o?.status === "completed" && o.kickoff_date ? (
                        <span className="text-ink-600">{formatDate(o.kickoff_date)}</span>
                      ) : (
                        <span className="text-ink-400">–</span>
                      )}
                    </td>
                    <td className="table-cell whitespace-nowrap text-right text-sm tabular-nums text-ink-700">
                      {client.deal_amount ? formatMoney(Number(client.deal_amount), client.deal_recurrence) : <span className="text-ink-400">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Chip({ href, on, label, count, subtle = false }: { href: string; on: boolean; label: string; count: number; subtle?: boolean }) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition",
        on ? "bg-brand-600 text-white" : subtle ? "bg-ink-50 text-ink-600 ring-1 ring-ink-200 hover:bg-white" : "bg-white text-ink-700 ring-1 ring-ink-200 hover:bg-ink-50",
      )}
    >
      {label}
      <span className={clsx("rounded-full px-1.5 text-xs tabular-nums", on ? "bg-white/20 text-white" : "bg-ink-100 text-ink-500")}>{count}</span>
    </Link>
  );
}
