import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { loadOnboardings } from "@/lib/queries";
import { EmptyState, PageHeader, Progress, StageBadge, Badge } from "@/components/ui";
import { formatDate } from "@/lib/time";

export const metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; stage?: string }> }) {
  const auth = await requireStaff();
  const { q = "", stage = "" } = await searchParams;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const clients = await tx.q<{ id: string; name: string; industry: string | null; primary_contact_name: string | null; created_at: Date }>(
      "select id, name, industry, primary_contact_name, created_at from clients where ($1 = '' or name ilike '%' || $1 || '%') order by name",
      [q],
    );
    const onboardings = await loadOnboardings(tx);
    return { clients, onboardings };
  });
  const latest = new Map<string, (typeof data.onboardings)[number]>();
  for (const o of data.onboardings) if (!latest.has(o.client_id)) latest.set(o.client_id, o);
  const rows = data.clients
    .map((c) => ({ client: c, onboarding: latest.get(c.id) }))
    .filter((r) => !stage || r.onboarding?.state.stage === stage);

  const stages = [
    ["", "All"],
    ["waiting_client", "Waiting on client"],
    ["review", "Needs review"],
    ["ready", "Ready to start"],
    ["paused", "Paused"],
    ["completed", "Completed"],
  ];

  return (
    <>
      <PageHeader title="Clients" description="Every client and where their onboarding stands." actions={<Link href="/app/clients/new" className="btn-primary">New client</Link>} />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 overflow-x-auto">
          {stages.map(([key, label]) => (
            <Link key={key} href={`/app/clients?stage=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${stage === key ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50"}`}>
              {label}
            </Link>
          ))}
        </div>
        <form className="sm:w-64">
          <input type="hidden" name="stage" value={stage} />
          <input name="q" defaultValue={q} placeholder="Search clients" className="input" aria-label="Search clients" />
        </form>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={q || stage ? "No clients match" : "No clients yet"} description={q || stage ? "Try a different filter." : "Add a client to start their onboarding."} action={<Link href="/app/clients/new" className="btn-primary">New client</Link>} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="hidden border-b border-ink-100 bg-ink-50/60 md:table-header-group">
              <tr>
                <th className="table-head">Client</th>
                <th className="table-head">Stage</th>
                <th className="table-head w-48">Progress</th>
                <th className="table-head">Owner</th>
                <th className="table-head">Issues</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map(({ client, onboarding: o }) => (
                <tr key={client.id} className="block hover:bg-ink-50 md:table-row">
                  <td className="table-cell block md:table-cell">
                    <Link href={`/app/clients/${client.id}`} className="font-medium text-ink-900 hover:text-brand-700">{client.name}</Link>
                    <p className="text-xs text-ink-500">{[client.industry, client.primary_contact_name].filter(Boolean).join(" · ") || "No details"}</p>
                  </td>
                  <td className="table-cell inline-block py-1 md:table-cell md:py-3">{o ? <StageBadge stage={o.state.stage} /> : <Badge>No onboarding</Badge>}</td>
                  <td className="table-cell block py-1 md:table-cell md:py-3">
                    {o && (
                      <div className="flex items-center gap-2">
                        <Progress value={o.state.progress.percent} />
                        <span className="w-10 text-right text-xs text-ink-500">{o.state.progress.percent}%</span>
                      </div>
                    )}
                  </td>
                  <td className="table-cell hidden text-ink-600 md:table-cell">{o?.owner_name ?? "–"}</td>
                  <td className="table-cell block pt-1 md:table-cell md:pt-3">
                    <div className="flex flex-wrap gap-1">
                      {o && o.state.overdue.length > 0 && <Badge tone="danger">{o.state.overdue.length} overdue</Badge>}
                      {o && o.state.awaitingReview.length > 0 && <Badge tone="info">{o.state.awaitingReview.length} to review</Badge>}
                      {o?.status === "completed" && <span className="text-xs text-ink-500">Completed {formatDate(o.completed_at)}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
