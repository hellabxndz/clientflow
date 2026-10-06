import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, EmptyState, Notice } from "@/components/ui";
import { emailConnection } from "@/lib/email";
import { formatDateTime } from "@/lib/time";

export const metadata = { title: "Email" };

export default async function EmailPage() {
  const auth = await requireStaff();
  const conn = emailConnection(auth.workspace);
  const { rows, counts } = await withTenant(tenantCtx(auth), async (tx) => ({
    rows: await tx.q<{ id: string; kind: string; to_email: string; subject: string; body: string; status: string; provider: string | null; error: string | null; created_at: Date; client_name: string | null }>(
      `select e.id, e.kind, e.to_email, e.subject, e.body, e.status, e.provider, e.error, e.created_at, c.name as client_name
       from email_messages e left join onboardings o on o.id = e.onboarding_id left join clients c on c.id = o.client_id
       order by e.created_at desc limit 100`,
    ),
    counts: (await tx.q<{ status: string; n: number }>("select status, count(*)::int as n from email_messages group by status")).reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: r.n }), {}),
  }));
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2" title="Email provider">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{conn.provider === "resend" ? "Resend" : conn.provider === "demo-outbox" ? "Demo outbox" : "Not connected"}</p>
              <p className="mt-1 text-sm text-ink-600">{conn.detail}</p>
            </div>
            <Badge tone={conn.mode === "live" ? "success" : conn.mode === "demo" ? "brand" : "warning"}>{conn.mode === "live" ? "Connected" : conn.mode === "demo" ? "Demo" : "Not configured"}</Badge>
          </div>
          {conn.mode === "not_configured" && (
            <Notice tone="warning" className="mt-4">Invitation links still work: copy them from the invite screen and share them yourself. Reminder attempts are logged as failed until a provider is configured.</Notice>
          )}
        </Card>
        <Card title="Delivery">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between"><span>Sent</span><span className="tabular-nums">{counts.sent ?? 0}</span></li>
            <li className="flex justify-between"><span>Demo (not sent)</span><span className="tabular-nums">{counts.simulated ?? 0}</span></li>
            <li className="flex justify-between"><span>Failed</span><span className="tabular-nums text-rose-700">{counts.failed ?? 0}</span></li>
            <li className="flex justify-between"><span>Queued</span><span className="tabular-nums">{counts.queued ?? 0}</span></li>
          </ul>
        </Card>
      </div>
      <Card title="Outbox and delivery log" padded={false}>
        {rows.length === 0 ? (
          <div className="p-5"><EmptyState title="No emails yet" /></div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {rows.map((r) => (
              <li key={r.id}>
                <details className="group px-5 py-3">
                  <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.subject}</p>
                      <p className="truncate text-xs text-ink-500">{r.kind} · {r.to_email}{r.client_name ? ` · ${r.client_name}` : ""} · {formatDateTime(r.created_at)}</p>
                    </div>
                    <Badge tone={r.status === "sent" ? "success" : r.status === "failed" ? "danger" : r.status === "simulated" ? "brand" : "neutral"}>{r.status === "simulated" ? "demo, not sent" : r.status}</Badge>
                  </summary>
                  {r.error && <p className="mt-2 text-sm text-rose-700">{r.error}</p>}
                  <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-ink-50 p-3 font-sans text-sm text-ink-700">{r.body}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
