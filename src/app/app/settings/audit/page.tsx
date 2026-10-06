import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Card, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const auth = await requireStaff();
  const page = Math.max(1, Number((await searchParams).page ?? 1) || 1);
  const rows = await withTenant(tenantCtx(auth), (tx) =>
    tx.q<{ id: number; action: string; summary: string; created_at: Date; actor: string | null; actor_role: string | null }>(
      `select a.id, a.action, a.summary, a.created_at, u.name as actor, m.role as actor_role
       from audit_events a left join users u on u.id = a.actor_user_id left join memberships m on m.user_id = a.actor_user_id
       order by a.created_at desc, a.id desc limit 51 offset $1`,
      [(page - 1) * 50],
    ),
  );
  return (
    <Card title="Audit history" padded={false}>
      {rows.length === 0 ? (
        <div className="p-5"><EmptyState title="No activity recorded yet" /></div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {rows.slice(0, 50).map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <span className="w-40 shrink-0 text-xs text-ink-500">{formatDateTime(r.created_at)}</span>
              <span className="min-w-0 flex-1 text-sm">{r.summary}</span>
              <span className="shrink-0 text-xs text-ink-500">{r.actor ?? "System"}{r.actor_role === "client" ? " (client)" : ""} · <code>{r.action}</code></span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between border-t border-ink-100 px-5 py-3 text-sm">
        {page > 1 ? <a className="link" href={`?page=${page - 1}`}>Newer</a> : <span />}
        {rows.length > 50 ? <a className="link" href={`?page=${page + 1}`}>Older</a> : <span />}
      </div>
    </Card>
  );
}
