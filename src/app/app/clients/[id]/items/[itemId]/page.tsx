import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames, type ItemRow } from "@/lib/queries";
import { isOverdue, unmetDependencies } from "@/lib/onboarding";
import { Badge, Card, Notice, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KindIcon, KIND_LABEL } from "@/components/kind";
import { ScanBadge, ReviewBadge, formatBytes } from "@/components/files";
import { formatDate, formatDateTime } from "@/lib/time";
import { getScanner } from "@/lib/scanning";
import type { FormField } from "@/lib/templates";
import {
  addCommentAction,
  reopenItemAction,
  reviewDocumentAction,
  reviewItemAction,
  setTaskStatusAction,
  staffUploadAction,
  updateItemAction,
} from "../../../../actions";

export const metadata = { title: "Item" };

export default async function StaffItemPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const auth = await requireStaff();
  const { id, itemId } = await params;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const item = await tx.one<ItemRow & { client_name: string; onboarding_status: string }>(
      `select i.*, c.name as client_name, o.status as onboarding_status from onboarding_items i
       join clients c on c.id = i.client_id join onboardings o on o.id = i.onboarding_id where i.id = $1 and i.client_id = $2`,
      [itemId, id],
    );
    if (!item) return null;
    const siblings = await tx.q<ItemRow>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
    const documents = await tx.q<{ id: string; title: string }>("select id, title from documents where item_id = $1 order by created_at", [itemId]);
    const versions = await tx.q<{
      id: string; document_id: string; version: number; original_name: string; size_bytes: number; scan_status: string; scan_detail: string | null;
      review_status: string; review_note: string | null; created_at: Date; uploader: string | null; purged_at: Date | null;
    }>(
      `select v.id, v.document_id, v.version, v.original_name, v.size_bytes::int, v.scan_status, v.scan_detail, v.review_status, v.review_note,
              v.created_at, u.name as uploader, v.purged_at
       from document_versions v join documents d on d.id = v.document_id left join users u on u.id = v.uploaded_by
       where d.item_id = $1 order by v.document_id, v.version desc`,
      [itemId],
    );
    const comments = await tx.q<{ id: string; body: string; visibility: string; created_at: Date; author: string | null }>(
      `select c.id, c.body, c.visibility, c.created_at, u.name as author from comments c left join users u on u.id = c.author_user_id
       where c.item_id = $1 order by c.created_at`,
      [itemId],
    );
    const history = await tx.q<{ summary: string; created_at: Date; actor: string | null }>(
      `select a.summary, a.created_at, u.name as actor from audit_events a left join users u on u.id = a.actor_user_id
       where a.entity_id = $1 or (a.metadata->>'itemId') = $1::text order by a.created_at desc limit 15`,
      [itemId],
    );
    return { item, siblings, documents, versions, comments, history, staff: await staffNames(tx) };
  });
  if (!data) notFound();
  const { item, staff } = data;
  const byKey = new Map(data.siblings.map((s) => [s.item_key, s]));
  const deps = item.depends_on.map((k) => byKey.get(k)).filter(Boolean) as ItemRow[];
  const unmet = unmetDependencies(item, byKey);
  const locked = item.onboarding_status === "completed";
  const config = item.config as { fields?: FormField[]; checklist?: { key: string; label: string; help?: string }[]; file?: { accept: string[]; maxSizeMb: number; maxFiles?: number }; signature?: { provider?: string; instructions: string } };
  const response = item.response as Record<string, unknown> & { checked?: string[]; notes?: Record<string, string>; answer?: string; client_note?: string };
  const scanner = getScanner();

  return (
    <>
      <div className="mb-2 text-sm"><Link href={`/app/clients/${id}`} className="text-ink-500 hover:text-ink-800">← {item.client_name}</Link></div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <KindIcon kind={item.kind} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{item.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <span>{item.section_title}</span>·<span>{KIND_LABEL[item.kind as keyof typeof KIND_LABEL]}</span>
              {item.audience === "internal" ? <Badge tone="brand">Internal, hidden from client</Badge> : <Badge>Client request</Badge>}
              {!item.required && <Badge>Optional</Badge>}
            </p>
          </div>
        </div>
        <StatusBadge status={item.status} task={item.kind === "task"} className="self-start text-sm" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {item.description && <p className="whitespace-pre-line text-[15px] text-ink-700">{item.description}</p>}
          {unmet.length > 0 && (
            <Notice tone="warning" title="Blocked">Waiting on {unmet.map((u) => `"${u.title}"`).join(", ")}.</Notice>
          )}

          {item.kind === "form" && (
            <Card title="Client answers" padded={false}>
              <dl className="divide-y divide-ink-100">
                {(config.fields ?? []).map((f) => {
                  const v = response[f.key];
                  const display = Array.isArray(v) ? v.join(", ") : v == null || v === "" ? null : String(v);
                  return (
                    <div key={f.key} className="grid gap-1 px-5 py-3 sm:grid-cols-3 sm:gap-4">
                      <dt className="text-sm text-ink-500">{f.label}{f.required && <span className="text-rose-600"> *</span>}</dt>
                      <dd className={clsx("whitespace-pre-line text-sm sm:col-span-2", !display && "italic text-ink-400")}>{display ?? "Not answered"}</dd>
                    </div>
                  );
                })}
              </dl>
            </Card>
          )}

          {item.kind === "checklist" && (
            <Card title="Access checklist" padded={false}>
              <ul className="divide-y divide-ink-100">
                {(config.checklist ?? []).map((c) => {
                  const done = response.checked?.includes(c.key);
                  return (
                    <li key={c.key} className="flex gap-3 px-5 py-3">
                      <span className={clsx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs", done ? "border-emerald-500 bg-emerald-500 text-white" : "border-ink-300")}>{done ? "✓" : ""}</span>
                      <div>
                        <p className="text-sm font-medium">{c.label}</p>
                        {c.help && <p className="text-xs text-ink-500">{c.help}</p>}
                        {response.notes?.[c.key] && <p className="mt-1 text-sm text-ink-700">Client note: {response.notes[c.key]}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">Clients confirm delegated access here. ClientFlow never collects passwords.</p>
            </Card>
          )}

          {item.kind === "question" && (
            <Card title="Client answer">
              <p className={clsx("whitespace-pre-line text-sm", !response.answer && "italic text-ink-400")}>{response.answer || "Not answered yet"}</p>
            </Card>
          )}

          {item.kind === "signature" && (
            <Card title="External e-signature">
              <Notice tone="info">
                Signatures happen in your e-signature provider{config.signature?.provider ? ` (${config.signature.provider})` : ""}. Approving this item records that your team received the signed copy. It is not itself a legal signature.
              </Notice>
              <p className="mt-3 text-sm text-ink-700">{config.signature?.instructions}</p>
              {response.client_note && <p className="mt-3 text-sm">Client says: <span className="text-ink-700">{response.client_note}</span></p>}
            </Card>
          )}

          {item.kind === "file" && (
            <Card title="Files" padded={false} action={<span className="text-xs text-ink-500">Accepts {config.file?.accept.map((a) => "." + a).join(", ")} · up to {Math.min(config.file?.maxSizeMb ?? 25, auth.workspace.max_upload_mb)} MB</span>}>
              {!scanner.configured && (
                <div className="border-b border-ink-100 px-5 py-2.5 text-xs text-amber-800 bg-amber-50">
                  Malware scanning is not configured, so these files have not been scanned. Configure a scanner before collecting sensitive documents.
                </div>
              )}
              {data.documents.length === 0 ? (
                <p className="px-5 py-4 text-sm text-ink-500">No files uploaded yet.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {data.documents.map((doc) => {
                    const versions = data.versions.filter((v) => v.document_id === doc.id);
                    return (
                      <li key={doc.id} className="px-5 py-4">
                        <p className="font-medium">{doc.title}</p>
                        <ul className="mt-2 space-y-2">
                          {versions.map((v, idx) => (
                            <li key={v.id} className={clsx("rounded-lg border p-3", idx === 0 ? "border-ink-200 bg-white" : "border-ink-100 bg-ink-50/60")}>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 text-sm">
                                  <span className="font-medium">v{v.version}</span> · {v.original_name} · {formatBytes(v.size_bytes)}
                                  <p className="text-xs text-ink-500">{v.uploader ?? "Unknown"} · {formatDateTime(v.created_at)}</p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <ScanBadge status={v.scan_status} />
                                  <ReviewBadge status={v.review_status} />
                                  {v.purged_at ? (
                                    <Badge>Deleted by retention</Badge>
                                  ) : (
                                    <a href={`/api/files/link?v=${v.id}`} className="btn-secondary px-2.5 py-1 text-xs">Download</a>
                                  )}
                                </div>
                              </div>
                              {v.review_note && <p className="mt-2 text-xs text-ink-600">Note: {v.review_note}</p>}
                              {idx === 0 && v.review_status === "pending" && !locked && (
                                <ActionForm action={reviewDocumentAction} className="mt-3 flex flex-col gap-2 sm:flex-row" showSuccess={false}>
                                  <input type="hidden" name="versionId" value={v.id} />
                                  <input name="note" className="input py-1.5 text-sm" placeholder="Note to client (required for changes)" />
                                  <div className="flex gap-2">
                                    <SubmitButton className="btn-secondary px-3 py-1.5 text-xs" name="decision" value="approved">Accept file</SubmitButton>
                                    <SubmitButton className="btn-danger px-3 py-1.5 text-xs" name="decision" value="changes_requested">Request changes</SubmitButton>
                                  </div>
                                </ActionForm>
                              )}
                            </li>
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!locked && item.status !== "approved" && (
                <ActionForm action={staffUploadAction} resetOnSuccess className="border-t border-ink-100 px-5 py-4">
                  <input type="hidden" name="itemId" value={item.id} />
                  <label className="label" htmlFor="file">Upload on the client's behalf</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input id="file" type="file" name="file" required className="input py-1.5 text-sm" accept={config.file?.accept.map((a) => "." + a).join(",")} />
                    <SubmitButton className="btn-secondary shrink-0" pendingText="Uploading…">Upload</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Comments" padded={false}>
            {data.comments.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No comments on this item.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.comments.map((c) => (
                  <li key={c.id} className={clsx("px-5 py-3", c.visibility === "internal" && "bg-amber-50/50")}>
                    <div className="flex justify-between text-xs">
                      <span className="font-medium">{c.author ?? "Former member"}</span>
                      <span className="text-ink-400">{formatDateTime(c.created_at)} · {c.visibility === "internal" ? "Internal note" : "Visible to client"}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2 border-t border-ink-100 p-4">
              <input type="hidden" name="onboardingId" value={item.onboarding_id} />
              <input type="hidden" name="itemId" value={item.id} />
              <textarea name="body" className="input min-h-[70px] text-sm" placeholder="Add a comment" required />
              <div className="flex items-center justify-between gap-2">
                <select name="visibility" className="input w-auto py-1.5 text-sm" defaultValue={item.audience === "internal" ? "internal" : "client"} aria-label="Visibility">
                  <option value="internal">Internal note</option>
                  {item.audience === "client" && <option value="client">Visible to client</option>}
                </select>
                <SubmitButton className="btn-primary px-3 py-1.5">Post</SubmitButton>
              </div>
            </ActionForm>
          </Card>
        </div>

        <div className="space-y-6">
          {!locked && (
            <Card title={item.kind === "task" ? "Task status" : "Review"}>
              {item.kind === "task" ? (
                <ActionForm action={setTaskStatusAction} className="space-y-2">
                  <input type="hidden" name="itemId" value={item.id} />
                  <div className="grid grid-cols-3 gap-2">
                    <SubmitButton className={item.status === "not_started" ? "btn-primary" : "btn-secondary"} name="status" value="not_started">To do</SubmitButton>
                    <SubmitButton className={item.status === "in_progress" ? "btn-primary" : "btn-secondary"} name="status" value="in_progress">Doing</SubmitButton>
                    <SubmitButton className={item.status === "approved" ? "btn-primary" : "btn-secondary"} name="status" value="approved" disabled={unmet.length > 0} title={unmet.length ? "Blocked by dependencies" : undefined}>Done</SubmitButton>
                  </div>
                </ActionForm>
              ) : item.status === "approved" ? (
                <ActionForm action={reopenItemAction} className="space-y-2">
                  <p className="text-sm text-ink-600">Approved{item.reviewed_by ? ` by ${staff.map.get(item.reviewed_by) ?? "a former member"}` : ""} {item.reviewed_at ? formatDate(item.reviewed_at) : ""}.</p>
                  <input type="hidden" name="itemId" value={item.id} />
                  <SubmitButton className="btn-secondary">Reopen for changes</SubmitButton>
                </ActionForm>
              ) : (
                <ActionForm action={reviewItemAction} className="space-y-3">
                  <input type="hidden" name="itemId" value={item.id} />
                  {item.status !== "submitted" && (
                    <p className="text-xs text-ink-500">The client hasn't submitted this yet. You can still approve it if you received it another way.</p>
                  )}
                  <textarea name="note" className="input min-h-[80px] text-sm" placeholder="Message to the client (required when requesting changes)" />
                  <div className="grid grid-cols-2 gap-2">
                    <SubmitButton name="decision" value="approve">Approve</SubmitButton>
                    <SubmitButton className="btn-danger" name="decision" value="changes">Request changes</SubmitButton>
                  </div>
                  {["legal", "tax", "identity", "financial"].some((w) => item.title.toLowerCase().includes(w)) && (
                    <p className="text-xs text-ink-500">Sensitive documents must be reviewed by a person. AI suggestions are never used to approve them.</p>
                  )}
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Details">
            <ActionForm action={updateItemAction} className="space-y-3">
              <input type="hidden" name="itemId" value={item.id} />
              <div>
                <label className="label" htmlFor="dueDate">Due date {isOverdue(item) && <span className="text-rose-700">(overdue)</span>}</label>
                <input id="dueDate" type="date" name="dueDate" className="input" defaultValue={item.due_at ? new Date(item.due_at).toISOString().slice(0, 10) : ""} disabled={locked} />
              </div>
              <div>
                <label className="label" htmlFor="ownerId">Owner</label>
                <select id="ownerId" name="ownerId" className="input" defaultValue={item.owner_user_id ?? ""} disabled={locked}>
                  <option value="">Unassigned</option>
                  {staff.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="required" defaultChecked={item.required} className="h-4 w-4 rounded" disabled={locked} /> Required for completion</label>
              {!locked && <SubmitButton className="btn-secondary">Save details</SubmitButton>}
            </ActionForm>
            {deps.length > 0 && (
              <div className="mt-4 border-t border-ink-100 pt-4">
                <p className="text-sm font-medium">Depends on</p>
                <ul className="mt-2 space-y-1.5">
                  {deps.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link href={`/app/clients/${id}/items/${d.id}`} className="link truncate">{d.title}</Link>
                      <StatusBadge status={d.status} task={d.kind === "task"} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card title="History" padded={false}>
            {data.history.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No recorded activity yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.history.map((h, i) => (
                  <li key={i} className="px-5 py-2.5 text-sm">
                    <p>{h.summary}</p>
                    <p className="text-xs text-ink-500">{h.actor ?? "System"} · {formatDateTime(h.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
