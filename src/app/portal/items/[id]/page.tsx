import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { unmetDependencies, isOverdue, type ItemLike } from "@/lib/onboarding";
import { Notice, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ReviewBadge, formatBytes } from "@/components/files";
import { formatDate, formatDateTime } from "@/lib/time";
import type { FormField } from "@/lib/templates";
import { clientCommentAction, clientUploadAction } from "../../actions";
import { ItemForm } from "./item-form";

export const metadata = { title: "Request" };

export default async function PortalItemPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireClient();
  const { id } = await params;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const item = await tx.one<ItemLike & {
      onboarding_id: string; description: string | null; response: Record<string, unknown>; onboarding_status: string; timezone: string;
      config: { fields?: FormField[]; checklist?: { key: string; label: string; help?: string }[]; file?: { accept: string[]; maxSizeMb: number; maxFiles?: number }; signature?: { provider?: string; instructions: string } };
    }>(
      `select i.*, o.status as onboarding_status, c.timezone from onboarding_items i join onboardings o on o.id = i.onboarding_id
       join clients c on c.id = i.client_id where i.id = $1`,
      [id],
    );
    if (!item) return null;
    const siblings = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
    const docs = await tx.q<{ document_id: string; title: string; version_id: string; version: number; original_name: string; size_bytes: number; review_status: string; review_note: string | null; created_at: Date; purged_at: Date | null }>(
      `select distinct on (d.id) d.id as document_id, d.title, v.id as version_id, v.version, v.original_name, v.size_bytes::int, v.review_status, v.review_note, v.created_at, v.purged_at
       from documents d join document_versions v on v.document_id = d.id where d.item_id = $1 order by d.id, v.version desc`,
      [id],
    );
    const comments = await tx.q<{ id: string; body: string; created_at: Date; author: string | null; mine: boolean }>(
      `select c.id, c.body, c.created_at, u.name as author, c.author_user_id = $2 as mine from comments c
       left join users u on u.id = c.author_user_id where c.item_id = $1 order by c.created_at`,
      [id, auth.user.id],
    );
    return { item, siblings, docs, comments };
  });
  if (!data) notFound();
  const { item } = data;
  const tz = item.timezone;
  const blocked = unmetDependencies(item, new Map(data.siblings.map((s) => [s.item_key, s])));
  const closed = item.onboarding_status === "completed" || item.onboarding_status === "cancelled";
  const locked = item.status === "approved" || closed || blocked.length > 0;
  const lastStaffComment = [...data.comments].reverse().find((c) => !c.mine);
  const maxMb = Math.min(item.config.file?.maxSizeMb ?? 25, auth.workspace.max_upload_mb);
  const ws = auth.workspace;

  return (
    <div className="space-y-5">
      <Link href="/portal" className="inline-flex items-center text-sm text-ink-500 hover:text-ink-800">← Back to checklist</Link>
      <div>
        <p className="text-sm font-medium" style={{ color: ws.brand_color }}>{item.section_title}</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
          <StatusBadge status={item.status} className="mt-1" />
        </div>
        {item.due_at && (
          <p className={isOverdue(item) ? "mt-1 text-sm font-medium text-rose-700" : "mt-1 text-sm text-ink-500"}>
            {isOverdue(item) ? "Overdue · was due" : "Due"} {formatDate(item.due_at, tz)}
          </p>
        )}
        {item.description && <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-ink-700">{item.description}</p>}
      </div>

      {item.status === "changes_requested" && (
        <Notice tone="danger" title="Changes requested">{lastStaffComment?.body ?? "The team asked for a few changes. See the comments below."}</Notice>
      )}
      {item.status === "submitted" && <Notice tone="info" title="Submitted">The team is reviewing this. You can still update it until it's approved.</Notice>}
      {item.status === "approved" && <Notice tone="success" title="Approved">Thanks, this one is done.</Notice>}
      {blocked.length > 0 && <Notice tone="warning" title="Not available yet">This opens once {blocked.map((b) => `“${b.title}”`).join(" and ")} {blocked.length > 1 ? "are" : "is"} approved.</Notice>}

      {item.kind === "file" && (
        <section className="card">
          <div className="border-b border-ink-100 px-5 py-3.5">
            <h2 className="font-semibold">Your files</h2>
            <p className="text-xs text-ink-500">Accepted: {item.config.file?.accept.map((a) => "." + a).join(", ")} · up to {maxMb} MB each{item.config.file?.maxFiles ? ` · up to ${item.config.file.maxFiles} files` : ""}</p>
          </div>
          {data.docs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-500">Nothing uploaded yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.docs.map((d) => (
                <li key={d.document_id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{d.original_name}</p>
                      <p className="text-xs text-ink-500">v{d.version} · {formatBytes(d.size_bytes)} · {formatDateTime(d.created_at, tz)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <ReviewBadge status={d.review_status} />
                      {!d.purged_at && <a href={`/api/files/link?v=${d.version_id}`} className="btn-secondary px-2.5 py-1 text-xs">View</a>}
                    </div>
                  </div>
                  {d.review_note && <p className="mt-1 text-sm text-rose-700">{d.review_note}</p>}
                  {!locked && (
                    <ActionForm action={clientUploadAction} className="mt-2">
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="documentId" value={d.document_id} />
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-ink-600">Upload a new version</summary>
                        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                          <input type="file" name="file" required className="input py-1.5 text-sm" accept={item.config.file?.accept.map((a) => "." + a).join(",")} />
                          <SubmitButton className="btn-secondary shrink-0" pendingText="Uploading…">Upload</SubmitButton>
                        </div>
                      </details>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!locked && (!item.config.file?.maxFiles || data.docs.length < item.config.file.maxFiles) && (
            <ActionForm action={clientUploadAction} resetOnSuccess className="border-t border-ink-100 p-5">
              <input type="hidden" name="itemId" value={item.id} />
              <label className="label" htmlFor="file">Add a file</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="file" type="file" name="file" required className="input py-2 text-sm" accept={item.config.file?.accept.map((a) => "." + a).join(",")} />
                <SubmitButton className="btn-secondary shrink-0" pendingText="Uploading…">Upload</SubmitButton>
              </div>
              <p className="mt-2 text-xs text-ink-500">Please don't upload passwords or files that contain them.</p>
            </ActionForm>
          )}
        </section>
      )}

      {item.kind !== "task" && (
        <ItemForm
          itemId={item.id}
          kind={item.kind}
          config={item.config}
          response={item.response}
          locked={locked}
          brandColor={ws.brand_color}
          hasFiles={data.docs.length > 0}
        />
      )}

      <section className="card">
        <div className="border-b border-ink-100 px-5 py-3.5">
          <h2 className="font-semibold">Questions or comments</h2>
        </div>
        {data.comments.length > 0 && (
          <ul className="divide-y divide-ink-100">
            {data.comments.map((c) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-medium">{c.mine ? "You" : c.author ?? ws.name}</span>
                  <span className="text-ink-400">{formatDateTime(c.created_at, tz)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <ActionForm action={clientCommentAction} resetOnSuccess className="space-y-2 border-t border-ink-100 p-4">
            <input type="hidden" name="onboardingId" value={item.onboarding_id} />
            <input type="hidden" name="itemId" value={item.id} />
            <textarea name="body" className="input min-h-[70px]" placeholder="Ask the team about this item" required />
            <SubmitButton className="btn-secondary" pendingText="Sending…">Send</SubmitButton>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
