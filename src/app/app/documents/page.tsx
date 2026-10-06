import Link from "next/link";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { ReviewBadge, ScanBadge, formatBytes } from "@/components/files";
import { formatDateTime } from "@/lib/time";
import { getScanner } from "@/lib/scanning";

export const metadata = { title: "Documents" };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const auth = await requireStaff();
  const { status = "all" } = await searchParams;
  const rows = await withTenant(tenantCtx(auth), (tx) =>
    tx.q<{
      version_id: string; document_id: string; title: string; version: number; size_bytes: number; scan_status: string; review_status: string;
      created_at: Date; client_id: string; client_name: string; item_id: string; item_title: string; uploader: string | null; purged_at: Date | null;
    }>(
      `select * from (
         select distinct on (d.id) v.id as version_id, d.id as document_id, d.title, v.version, v.size_bytes::int, v.scan_status, v.review_status,
                v.created_at, c.id as client_id, c.name as client_name, i.id as item_id, i.title as item_title, u.name as uploader, v.purged_at
         from documents d join document_versions v on v.document_id = d.id join clients c on c.id = d.client_id
         join onboarding_items i on i.id = d.item_id left join users u on u.id = v.uploaded_by
         order by d.id, v.version desc) latest
       where ($1 = 'all' or review_status = $1) order by created_at desc limit 200`,
      [status],
    ),
  );
  const scanner = getScanner();
  const tabs = [
    ["all", "All"],
    ["pending", "Pending review"],
    ["changes_requested", "Changes requested"],
    ["approved", "Accepted"],
  ];
  return (
    <>
      <PageHeader title="Documents" description="Latest version of every file clients have uploaded. Files are stored privately and downloaded through links that expire after five minutes." />
      {!scanner.configured && (
        <Notice tone="warning" title="Malware scanning is not configured" className="mb-5">
          Uploads are checked for type and size but are not scanned for malware. Set CLAMAV_HOST (or connect another scanner) before collecting sensitive documents from live clients.
        </Notice>
      )}
      <div className="mb-4 flex flex-wrap gap-1">
        {tabs.map(([k, label]) => (
          <Link key={k} href={`/app/documents?status=${k}`} className={clsx("rounded-full px-3 py-1.5 text-sm font-medium", status === k ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200")}>{label}</Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No documents" description="Files clients upload will appear here." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="hidden border-b border-ink-100 bg-ink-50/60 md:table-header-group">
              <tr>
                <th className="table-head">File</th>
                <th className="table-head">Client</th>
                <th className="table-head">Uploaded</th>
                <th className="table-head">Status</th>
                <th className="table-head" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rows.map((r) => (
                <tr key={r.version_id} className="block md:table-row">
                  <td className="table-cell block md:table-cell">
                    <Link href={`/app/clients/${r.client_id}/items/${r.item_id}`} className="font-medium text-ink-900 hover:text-brand-700">{r.title}</Link>
                    <p className="text-xs text-ink-500">{r.item_title} · v{r.version} · {formatBytes(r.size_bytes)}</p>
                  </td>
                  <td className="table-cell block py-0 text-sm md:table-cell md:py-3">{r.client_name}</td>
                  <td className="table-cell block py-1 text-xs text-ink-500 md:table-cell md:py-3">{r.uploader ?? "Unknown"} · {formatDateTime(r.created_at)}</td>
                  <td className="table-cell block py-1 md:table-cell md:py-3">
                    <div className="flex flex-wrap gap-1"><ReviewBadge status={r.review_status} /><ScanBadge status={r.scan_status} /></div>
                  </td>
                  <td className="table-cell block md:table-cell md:text-right">
                    {r.purged_at ? <span className="text-xs text-ink-400">Deleted (retention)</span> : <a href={`/api/files/link?v=${r.version_id}`} className="btn-secondary px-2.5 py-1 text-xs">Download</a>}
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
