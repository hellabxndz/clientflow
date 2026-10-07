import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { can, ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/auth";
import { Badge, Card, EmptyState, Notice } from "@/components/ui";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Audit log" };

type Params = { page?: string; category?: string; actor?: string; from?: string; to?: string };

const CATEGORY_LABEL: Record<string, string> = {
  automation: "Automations",
  integration: "Integrations",
  template: "Templates",
  reminder: "Reminders",
  reminder_rule: "Reminder rules",
  reminders: "Reminder runs",
  member: "Team members",
  invitation: "Invitations",
  item: "Items and reviews",
  document: "Documents",
  onboarding: "Onboardings",
  client: "Clients",
  client_type: "Client types",
  workspace: "Workspace settings",
  import: "Data import",
  sessions: "Sessions",
  deal: "CRM deals",
  launch: "Launch",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Params> }) {
  const auth = await requireStaff();
  if (!can(auth.role, "viewAudit")) return <Notice>Only workspace admins can view the audit log.</Notice>;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const category = sp.category && /^[a-z_]+$/.test(sp.category) ? sp.category : "";
  const actor = sp.actor === "system" || (sp.actor && UUID.test(sp.actor)) ? sp.actor : "";
  const from = sp.from && DATE.test(sp.from) ? sp.from : "";
  const to = sp.to && DATE.test(sp.to) ? sp.to : "";

  const data = await withTenant(tenantCtx(auth), async (tx) => ({
    rows: await tx.q<{
      id: number;
      action: string;
      summary: string;
      created_at: Date;
      actor: string | null;
      actor_role: Role | null;
      client_id: string | null;
      client_name: string | null;
      category: string;
    }>(
      `select a.id, a.action, a.summary, a.created_at, u.name as actor, m.role as actor_role, a.client_id, c.name as client_name,
              coalesce(a.category, split_part(a.action, '.', 1)) as category
       from audit_events a left join users u on u.id = a.actor_user_id left join memberships m on m.user_id = a.actor_user_id
       left join clients c on c.id = a.client_id
       where ($1 = '' or coalesce(a.category, split_part(a.action, '.', 1)) = $1)
         and ($2 = '' or ($2 = 'system' and a.actor_user_id is null) or a.actor_user_id::text = $2)
         and ($3 = '' or a.created_at >= nullif($3, '')::date)
         and ($4 = '' or a.created_at < nullif($4, '')::date + 1)
       order by a.created_at desc, a.id desc limit 51 offset $5`,
      [category, actor, from, to, (page - 1) * 50],
    ),
    categories: await tx.q<{ category: string; n: number }>(
      "select coalesce(category, split_part(action, '.', 1)) as category, count(*)::int as n from audit_events group by 1 order by 1",
    ),
    actors: await tx.q<{ id: string; name: string; role: Role }>(
      "select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id order by m.role = 'client', u.name",
    ),
  }));

  const qs = (over: Partial<Params>) => {
    const p = new URLSearchParams();
    const merged = { category, actor, from, to, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "?";
  };
  const filtered = !!(category || actor || from || to);

  return (
    <div className="space-y-4">
      <Card>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end" method="get">
          <div>
            <label className="label" htmlFor="category">Category</label>
            <select id="category" name="category" className="input" defaultValue={category}>
              <option value="">All categories</option>
              {data.categories.map((c) => (
                <option key={c.category} value={c.category}>{CATEGORY_LABEL[c.category] ?? c.category} ({c.n})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="actor">Actor</label>
            <select id="actor" name="actor" className="input" defaultValue={actor}>
              <option value="">Anyone</option>
              <option value="system">System and automations</option>
              {data.actors.map((a) => <option key={a.id} value={a.id}>{a.name} ({ROLE_LABEL[a.role]})</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="date" className="input" defaultValue={from} />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="date" className="input" defaultValue={to} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" type="submit">Filter</button>
            {filtered && <Link href="/app/settings/audit" className="btn-ghost">Clear</Link>}
          </div>
        </form>
      </Card>

      <Card title="Audit history" padded={false}>
        {data.rows.length === 0 ? (
          <div className="p-5"><EmptyState title={filtered ? "No events match these filters" : "No activity recorded yet"} /></div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.rows.slice(0, 50).map((r) => (
              <li key={r.id} className="flex flex-col gap-1 px-5 py-3 md:flex-row md:items-start md:gap-4">
                <span className="w-36 shrink-0 text-xs text-ink-500 md:pt-0.5">{formatDateTime(r.created_at, auth.workspace.timezone)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-800">{r.summary}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                    <Link href={`/app/settings/audit${qs({ category: r.category, page: undefined })}`}>
                      <Badge>{CATEGORY_LABEL[r.category] ?? r.category}</Badge>
                    </Link>
                    {r.client_id && r.client_name && (
                      <Link href={`/app/clients/${r.client_id}`} className="link">{r.client_name}</Link>
                    )}
                    <code className="truncate">{r.action}</code>
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-500">
                  {r.actor ?? "System"}
                  {r.actor_role ? ` · ${ROLE_LABEL[r.actor_role]}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between border-t border-ink-100 px-5 py-3 text-sm">
          {page > 1 ? <Link className="link" href={`/app/settings/audit${qs({ page: String(page - 1) })}`}>Newer</Link> : <span />}
          {data.rows.length > 50 ? <Link className="link" href={`/app/settings/audit${qs({ page: String(page + 1) })}`}>Older</Link> : <span />}
        </div>
      </Card>
    </div>
  );
}
