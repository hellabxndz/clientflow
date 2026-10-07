import Link from "next/link";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { DOC_CATEGORIES, SENSITIVE_CATEGORIES } from "@/lib/templates";
import { getScanner } from "@/lib/scanning";
import { formatDateTime } from "@/lib/time";
import { Badge, EmptyState, Notice, PageHeader } from "@/components/ui";
import { ScanBadge, formatBytes } from "@/components/files";
import { DocReviewBadge, ExpiryBadge, SCAN_NOT_CONFIGURED, daysUntil } from "../clients/[id]/shared";

export const metadata = { title: "Documents" };

interface DocRow {
  version_id: string;
  document_id: string;
  title: string;
  version: number;
  versions: number;
  size_bytes: number;
  scan_status: string;
  review_status: string;
  expires_on: string | null;
  created_at: Date;
  client_id: string;
  client_name: string;
  item_id: string;
  item_title: string;
  category: string | null;
  uploader: string | null;
  uploader_role: string | null;
  reviewer: string | null;
  reviewed_by: string | null;
  purged_at: Date | null;
}

const STATUS_FILTERS = [
  ["all", "All"],
  ["pending", "Pending review"],
  ["changes_requested", "Changes requested"],
  ["rejected", "Rejected"],
  ["approved", "Accepted"],
  ["expiring", "Expiring ≤ 30 days"],
  ["expired", "Expired"],
] as const;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ status?: string; category?: string; client?: string }> }) {
  const auth = await requireStaff();
  const sp = await searchParams;
  const status = STATUS_FILTERS.some(([k]) => k === sp.status) ? sp.status! : "all";
  const category = sp.category && (DOC_CATEGORIES as readonly string[]).includes(sp.category) ? sp.category : "";
  const clientFilter = sp.client && /^[0-9a-f-]{36}$/i.test(sp.client) ? sp.client : "";
  const { rows, clients } = await withTenant(tenantCtx(auth), async (tx) => ({
    rows: await tx.q<DocRow>(
      `select distinct on (d.id) v.id as version_id, d.id as document_id, d.title, v.version,
              (select count(*)::int from document_versions x where x.document_id = d.id) as versions, v.size_bytes::int, v.scan_status, v.review_status,
              v.expires_on::text, v.created_at, c.id as client_id, c.name as client_name, i.id as item_id, i.title as item_title,
              coalesce(d.category, i.category) as category, u.name as uploader, m.role as uploader_role, r.name as reviewer, rb.name as reviewed_by, v.purged_at
       from documents d join document_versions v on v.document_id = d.id join clients c on c.id = d.client_id
       join onboarding_items i on i.id = d.item_id left join users u on u.id = v.uploaded_by
       left join memberships m on m.user_id = v.uploaded_by left join users r on r.id = i.reviewer_user_id left join users rb on rb.id = v.reviewed_by
       where ($1 = '' or d.client_id = $1::uuid)
       order by d.id, v.version desc`,
      [clientFilter],
    ),
    clients: await tx.q<{ id: string; name: string }>("select distinct c.id, c.name from clients c join documents d on d.client_id = c.id order by c.name"),
  }));
  const scanner = getScanner();
  const filtered = rows
    .filter((r) => {
      if (category && r.category !== category) return false;
      if (status === "expiring") return !!r.expires_on && daysUntil(r.expires_on) >= 0 && daysUntil(r.expires_on) <= 30;
      if (status === "expired") return !!r.expires_on && daysUntil(r.expires_on) < 0;
      if (status !== "all") return r.review_status === status;
      return true;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const expiringCount = rows.filter((r) => r.expires_on && daysUntil(r.expires_on) <= 30).length;
  const href = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ ...(status !== "all" && { status }), ...(category && { category }), ...(clientFilter && { client: clientFilter }), ...patch });
    for (const [k, v] of [...p.entries()]) if (!v || v === "all") p.delete(k);
    const q = p.toString();
    return `/app/documents${q ? `?${q}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Documents"
        description="Latest version of every file clients have uploaded. Files are stored privately and downloaded through signed links that expire after five minutes; every download is recorded in the audit log."
      />
      {!scanner.configured && (
        <Notice tone="warning" title="Malware scanning is not configured" className="mb-5">
          {SCAN_NOT_CONFIGURED}
        </Notice>
      )}
      {expiringCount > 0 && status !== "expiring" && status !== "expired" && (
        <Notice className="mb-5">
          {expiringCount} document{expiringCount === 1 ? " is" : "s are"} expired or expiring within 30 days.{" "}
          <Link href={href({ status: "expiring" })} className="link">
            Review them
          </Link>
        </Notice>
      )}

      <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map(([k, label]) => (
            <Link
              key={k}
              href={href({ status: k })}
              className={clsx("rounded-full px-3 py-1.5 text-sm font-medium", status === k ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50")}
            >
              {label}
            </Link>
          ))}
        </div>
        <form className="flex flex-wrap items-center gap-2" action="/app/documents">
          {status !== "all" && <input type="hidden" name="status" value={status} />}
          <select name="category" defaultValue={category} className="input w-auto py-1.5 text-sm" aria-label="Category">
            <option value="">All categories</option>
            {DOC_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select name="client" defaultValue={clientFilter} className="input w-auto max-w-[220px] py-1.5 text-sm" aria-label="Client">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary px-3 py-1.5 text-sm">Filter</button>
          {(category || clientFilter) && (
            <Link href={href({ category: "", client: "" })} className="text-sm link">
              Clear
            </Link>
          )}
        </form>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No documents" description={rows.length ? "No documents match these filters." : "Files clients upload will appear here."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[960px]">
            <thead className="border-b border-ink-100 bg-ink-50/60">
              <tr>
                <th className="table-head">File</th>
                <th className="table-head">Client</th>
                <th className="table-head">Category</th>
                <th className="table-head">Review</th>
                <th className="table-head">Reviewer</th>
                <th className="table-head">Uploaded</th>
                <th className="table-head">Expires</th>
                <th className="table-head">Scan</th>
                <th className="table-head" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {filtered.map((r) => (
                <tr key={r.version_id} className="hover:bg-ink-50">
                  <td className="table-cell max-w-[260px]">
                    <Link href={`/app/clients/${r.client_id}/items/${r.item_id}`} className="block truncate font-medium text-ink-900 hover:text-brand-700">
                      {r.title}
                    </Link>
                    <p className="truncate text-xs text-ink-500">
                      {r.item_title} · v{r.version}
                      {r.versions > 1 && ` (${r.versions} versions)`} · {formatBytes(r.size_bytes)}
                    </p>
                  </td>
                  <td className="table-cell">
                    <Link href={`/app/clients/${r.client_id}?tab=documents`} className="hover:text-brand-700">
                      {r.client_name}
                    </Link>
                  </td>
                  <td className="table-cell">
                    {r.category ? <Badge tone={SENSITIVE_CATEGORIES.has(r.category) ? "warning" : "neutral"}>{r.category}</Badge> : <span className="text-xs text-ink-400">None</span>}
                  </td>
                  <td className="table-cell">
                    <DocReviewBadge status={r.review_status} />
                    {r.reviewed_by && r.review_status !== "pending" && <p className="mt-0.5 text-xs text-ink-500">by {r.reviewed_by}</p>}
                  </td>
                  <td className="table-cell text-sm">{r.reviewer ?? <span className="text-xs text-ink-400">Unassigned</span>}</td>
                  <td className="table-cell text-xs text-ink-500">
                    {r.uploader ?? "Unknown"}
                    {r.uploader_role === "client" ? " (client)" : r.uploader_role ? " (team)" : ""}
                    <br />
                    {formatDateTime(r.created_at)}
                  </td>
                  <td className="table-cell">{r.expires_on ? <ExpiryBadge expiresOn={r.expires_on} /> : <span className="text-xs text-ink-400">None</span>}</td>
                  <td className="table-cell">
                    <ScanBadge status={r.scan_status} />
                  </td>
                  <td className="table-cell text-right">
                    {r.purged_at ? (
                      <span className="text-xs text-ink-400">Deleted (retention)</span>
                    ) : (
                      <a href={`/api/files/link?v=${r.version_id}`} className="btn-secondary px-2.5 py-1 text-xs">
                        Download
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">
        {filtered.length} of {rows.length} document{rows.length === 1 ? "" : "s"}
      </p>
    </>
  );
}
