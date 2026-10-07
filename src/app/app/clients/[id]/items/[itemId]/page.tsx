import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { ArrowRight, Check, ExternalLink, KeyRound, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames, type ItemRow } from "@/lib/queries";
import { displayStatus, isOverdue, STATUS_LABEL, unmetDependencies, type ItemLike, type ItemStatus } from "@/lib/onboarding";
import { SENSITIVE_CATEGORIES, type FormField } from "@/lib/templates";
import { can, ROLE_LABEL } from "@/lib/permissions";
import { getScanner } from "@/lib/scanning";
import { formatDate, formatDateTime } from "@/lib/time";
import { Badge, Card, Notice, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KindIcon, KIND_LABEL } from "@/components/kind";
import { ScanBadge, formatBytes } from "@/components/files";
import {
  addCommentAction,
  reassignReviewerAction,
  removeRequirementAction,
  reopenItemAction,
  restoreRequirementAction,
  reviewDocumentAction,
  reviewItemAction,
  setDocumentExpiryAction,
  setTaskStatusAction,
  staffUploadAction,
  startReviewAction,
  updateItemAction,
} from "../../../../actions";
import { CommentList, DocReviewBadge, ExpiryBadge, SCAN_NOT_CONFIGURED, type CommentRow } from "../../shared";

export const metadata = { title: "Item" };

interface AccessConfig {
  platform: string;
  instructions: string;
  inviteEmail?: string;
  accessLevel?: string;
  helpUrl?: string;
  accountIdLabel?: string;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  original_name: string;
  size_bytes: number;
  scan_status: string;
  scan_detail: string | null;
  review_status: string;
  review_note: string | null;
  reviewed_at: Date | null;
  reviewer: string | null;
  expires_on: string | null;
  created_at: Date;
  uploader: string | null;
  uploader_role: string | null;
  purged_at: Date | null;
}

export default async function StaffItemPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const auth = await requireStaff();
  const { id, itemId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(itemId)) notFound();
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const item = await tx.one<ItemRow & { client_name: string; onboarding_status: string; review_required: boolean }>(
      `select i.*, c.name as client_name, o.status as onboarding_status from onboarding_items i
       join clients c on c.id = i.client_id join onboardings o on o.id = i.onboarding_id where i.id = $1 and i.client_id = $2`,
      [itemId, id],
    );
    if (!item) return null;
    const siblings = await tx.q<ItemRow>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
    const documents = await tx.q<{ id: string; title: string; category: string | null }>(
      "select id, title, category from documents where item_id = $1 order by created_at",
      [itemId],
    );
    const versions = await tx.q<VersionRow>(
      `select v.id, v.document_id, v.version, v.original_name, v.size_bytes::int, v.scan_status, v.scan_detail, v.review_status, v.review_note,
              v.reviewed_at, r.name as reviewer, v.expires_on::text, v.created_at, u.name as uploader, m.role as uploader_role, v.purged_at
       from document_versions v join documents d on d.id = v.document_id left join users u on u.id = v.uploaded_by
       left join memberships m on m.user_id = v.uploaded_by left join users r on r.id = v.reviewed_by
       where d.item_id = $1 order by v.document_id, v.version desc`,
      [itemId],
    );
    const comments = await tx.q<CommentRow>(
      `select c.id, c.body, c.visibility, c.created_at, c.source, u.name as author, m.role as author_role
       from comments c left join users u on u.id = c.author_user_id left join memberships m on m.user_id = c.author_user_id
       where c.item_id = $1 order by c.created_at desc`,
      [itemId],
    );
    const statusHistory = await tx.q<{ id: string; from_status: string | null; to_status: string; created_at: Date; actor: string | null; actor_role: string | null }>(
      `select h.id::text, h.from_status, h.to_status, h.created_at, u.name as actor, h.actor_role
       from item_status_history h left join users u on u.id = h.actor_user_id where h.item_id = $1 order by h.created_at desc, h.id desc limit 50`,
      [itemId],
    );
    const activity = await tx.q<{ summary: string; created_at: Date; actor: string | null }>(
      `select a.summary, a.created_at, u.name as actor from audit_events a left join users u on u.id = a.actor_user_id
       where (a.entity_type = 'item' and a.entity_id = $1)
          or (a.entity_type = 'document_version' and a.entity_id in (select v.id from document_versions v join documents d on d.id = v.document_id where d.item_id = $1))
       order by a.created_at desc limit 20`,
      [itemId],
    );
    return { item, siblings, documents, versions, comments, statusHistory, activity, staff: await staffNames(tx) };
  });
  if (!data) notFound();
  const { item, staff } = data;
  const byKey = new Map<string, ItemLike>(data.siblings.filter((s) => !s.removed_at).map((s) => [s.item_key, s]));
  const deps = item.depends_on.map((k) => byKey.get(k)).filter(Boolean) as ItemLike[];
  const dependents = data.siblings.filter((s) => !s.removed_at && s.depends_on.includes(item.item_key));
  const unmet = unmetDependencies(item, byKey);
  const status = displayStatus(item, byKey);
  const closed = item.onboarding_status === "completed" || item.onboarding_status === "cancelled";
  const removed = !!item.removed_at;
  const locked = closed || removed;
  const config = item.config as {
    fields?: FormField[];
    checklist?: { key: string; label: string; help?: string }[];
    file?: { accept: string[]; maxSizeMb: number; maxFiles?: number };
    signature?: { provider?: string; instructions: string };
    access?: AccessConfig;
  };
  const response = item.response as Record<string, unknown> & {
    checked?: string[];
    notes?: Record<string, string>;
    answer?: string;
    client_note?: string;
    confirmed?: boolean;
    accountId?: string;
    note?: string;
  };
  const scanner = getScanner();
  const sensitive = !!item.category && SENSITIVE_CATEGORIES.has(item.category);
  const isManager = auth.role === "admin" || auth.role === "manager";
  const awaiting = item.status === "submitted" || item.status === "under_review";
  const reviewerName = item.reviewer_user_id ? staff.map.get(item.reviewer_user_id) ?? "A former member" : null;
  const latestByDoc = new Map<string, VersionRow>();
  for (const v of data.versions) if (!latestByDoc.has(v.document_id)) latestByDoc.set(v.document_id, v);
  const allDocsAccepted = data.documents.length > 0 && [...latestByDoc.values()].every((v) => v.review_status === "approved");

  return (
    <>
      <div className="mb-3 text-sm">
        <Link href={`/app/clients/${id}`} className="text-ink-500 hover:text-ink-800">
          ← {item.client_name}
        </Link>
      </div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <KindIcon kind={item.kind} />
          <div className="min-w-0">
            <h1 className={clsx("text-2xl font-semibold tracking-tight text-ink-900", removed && "line-through decoration-ink-300")}>{item.title}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <span>{item.section_title}</span>·<span>{KIND_LABEL[item.kind as keyof typeof KIND_LABEL] ?? item.kind}</span>
              {item.audience === "internal" ? <Badge tone="brand">Internal, hidden from client</Badge> : <Badge>Client request</Badge>}
              <Badge>{item.required ? "Required" : "Optional"}</Badge>
              {item.critical && <Badge tone="danger">Critical</Badge>}
              {(item.weight ?? 1) > 1 && <Badge>Weight ×{item.weight}</Badge>}
              {item.category && <Badge tone={sensitive ? "warning" : "neutral"}>{item.category}</Badge>}
            </p>
          </div>
        </div>
        <StatusBadge status={status} task={item.kind === "task"} className="self-start text-sm" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-6 xl:col-span-2">
          {removed && (
            <Notice tone="warning" title="Removed requirement">
              Removed from this onboarding on {formatDate(item.removed_at)}. It no longer counts toward readiness and the client can't see it. Its history and files are kept.
            </Notice>
          )}
          {item.description && <p className="whitespace-pre-line text-[15px] text-ink-700">{item.description}</p>}
          {unmet.length > 0 && (
            <Notice tone="warning" title="Blocked">
              Waiting on {unmet.map((u) => `"${u.title}"`).join(", ")} to be approved.
            </Notice>
          )}
          {sensitive && (
            <Notice title="Human review required">
              This is a {item.category} item. It is always reviewed by a person and is never approved automatically or by AI.
            </Notice>
          )}
          {!item.review_required && !sensitive && item.audience === "client" && (
            <p className="text-xs text-ink-500">This item doesn't need staff review: the client's submission is approved automatically. Staff can still approve or reopen it here.</p>
          )}

          {item.kind === "form" && (
            <Card title="Client answers" padded={false}>
              <dl className="divide-y divide-ink-100">
                {(config.fields ?? []).map((f) => {
                  const v = response[f.key];
                  const display = Array.isArray(v) ? v.join(", ") : v == null || v === "" ? null : String(v);
                  return (
                    <div key={f.key} className="grid gap-1 px-5 py-3 sm:grid-cols-3 sm:gap-4">
                      <dt className="text-sm text-ink-500">
                        {f.label}
                        {f.required && <span className="text-rose-600"> *</span>}
                      </dt>
                      <dd className={clsx("whitespace-pre-line break-words text-sm sm:col-span-2", !display && "italic text-ink-400")}>{display ?? "Not answered"}</dd>
                    </div>
                  );
                })}
              </dl>
            </Card>
          )}

          {item.kind === "checklist" && (
            <Card title="Checklist" padded={false}>
              <ul className="divide-y divide-ink-100">
                {(config.checklist ?? []).map((c) => {
                  const done = response.checked?.includes(c.key);
                  return (
                    <li key={c.key} className="flex gap-3 px-5 py-3">
                      <span className={clsx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border", done ? "border-emerald-500 bg-emerald-500 text-white" : "border-ink-300")}>
                        {done && <Check className="h-3.5 w-3.5" />}
                      </span>
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

          {item.kind === "access" && (
            <Card title={config.access ? `${config.access.platform} access` : "Account access"} padded={false}>
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Client confirmed</p>
                  <p className={clsx("mt-1 inline-flex items-center gap-1.5 text-sm font-medium", response.confirmed ? "text-emerald-700" : "text-ink-500")}>
                    {response.confirmed ? <Check className="h-4 w-4" /> : null}
                    {response.confirmed ? "Access granted" : "Not confirmed yet"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{config.access?.accountIdLabel ?? "Account ID"}</p>
                  <p className={clsx("mt-1 break-words font-mono text-sm", !response.accountId && "font-sans italic text-ink-400")}>{response.accountId || "Not provided"}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Access level requested</p>
                  <p className="mt-1 text-sm text-ink-800">{config.access?.accessLevel ?? "Not specified"}</p>
                </div>
              </div>
              {response.note && (
                <div className="border-t border-ink-100 px-5 py-3 text-sm">
                  <span className="text-ink-500">Client note: </span>
                  <span className="whitespace-pre-line text-ink-800">{response.note}</span>
                </div>
              )}
              {config.access && (
                <div className="border-t border-ink-100 bg-ink-50/60 px-5 py-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    <KeyRound className="h-3.5 w-3.5" /> Instructions shown to the client
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm text-ink-700">{config.access.instructions}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
                    {config.access.inviteEmail && <span>Invite: {config.access.inviteEmail}</span>}
                    {config.access.helpUrl && (
                      <a href={config.access.helpUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
                        Platform help <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              )}
              <p className="border-t border-ink-100 px-5 py-2.5 text-xs text-ink-500">
                Delegated access only. ClientFlow never asks clients for passwords. Verify the access in {config.access?.platform ?? "the platform"} before approving.
              </p>
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
                Signatures happen in your e-signature provider{config.signature?.provider ? ` (${config.signature.provider})` : ""}. Approving this item records that your team received the signed
                copy. It is not itself a legal signature.
              </Notice>
              <p className="mt-3 text-sm text-ink-700">{config.signature?.instructions}</p>
              {response.client_note && (
                <p className="mt-3 text-sm">
                  Client says: <span className="text-ink-700">{response.client_note}</span>
                </p>
              )}
            </Card>
          )}

          {item.kind === "file" && (
            <Card
              title="Files"
              padded={false}
              action={
                config.file && (
                  <span className="text-xs text-ink-500">
                    Accepts {config.file.accept.map((a) => "." + a).join(", ")} · up to {Math.min(config.file.maxSizeMb, auth.workspace.max_upload_mb)} MB
                  </span>
                )
              }
            >
              {(!scanner.configured || data.versions.some((v) => v.scan_status === "not_scanned")) && (
                <p className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs font-medium text-amber-900">{SCAN_NOT_CONFIGURED}</p>
              )}
              {data.documents.length === 0 ? (
                <p className="px-5 py-4 text-sm text-ink-500">No files uploaded yet.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {data.documents.map((doc) => {
                    const versions = data.versions.filter((v) => v.document_id === doc.id);
                    const [latest, ...previous] = versions;
                    if (!latest) return null;
                    return (
                      <li key={doc.id} className="px-5 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-ink-900">{doc.title}</p>
                          <span className="text-xs text-ink-500">
                            {versions.length} version{versions.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        <VersionCard v={latest} latest />
                        {latest.review_status === "pending" && !locked && auth.canApprove && (
                          <ActionForm action={reviewDocumentAction} className="mt-3 space-y-2 rounded-lg border border-ink-100 bg-ink-50/60 p-3">
                            <input type="hidden" name="versionId" value={latest.id} />
                            <textarea name="note" className="input min-h-[60px] text-sm" placeholder="Review note (required to request changes or reject)" />
                            <div className="flex flex-wrap items-center gap-3 text-sm">
                              <select name="noteVisibility" className="input w-auto py-1.5 text-sm" aria-label="Note visibility" defaultValue="client">
                                <option value="client">Note visible to client</option>
                                <option value="internal">Internal note (accept only)</option>
                              </select>
                              <label className="flex items-center gap-2">
                                <span className="text-ink-600">Expires</span>
                                <input type="date" name="expiresOn" className="input w-auto py-1.5 text-sm" defaultValue={latest.expires_on ?? ""} />
                              </label>
                            </div>
                            {awaiting && (
                              <label className="flex items-center gap-2 text-xs text-ink-600">
                                <input type="checkbox" name="approveItem" defaultChecked={data.documents.length === 1} className="h-4 w-4 rounded" /> Also approve the request when every file is accepted
                              </label>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <SubmitButton className="btn-primary px-3 py-1.5 text-xs" name="decision" value="approved">
                                Accept file
                              </SubmitButton>
                              <SubmitButton className="btn-secondary px-3 py-1.5 text-xs" name="decision" value="changes_requested">
                                Request changes
                              </SubmitButton>
                              <SubmitButton className="btn-danger px-3 py-1.5 text-xs" name="decision" value="rejected">
                                Reject file
                              </SubmitButton>
                            </div>
                          </ActionForm>
                        )}
                        {latest.review_status !== "pending" && !locked && (
                          <ActionForm action={setDocumentExpiryAction} className="mt-2 flex flex-wrap items-center gap-2 text-xs" showSuccess={false}>
                            <input type="hidden" name="versionId" value={latest.id} />
                            <span className="text-ink-500">Expiry date</span>
                            <input type="date" name="expiresOn" className="input w-auto py-1 text-xs" defaultValue={latest.expires_on ?? ""} aria-label="Expiry date" />
                            <SubmitButton className="btn-ghost px-2 py-1 text-xs">Save</SubmitButton>
                          </ActionForm>
                        )}
                        {previous.length > 0 && (
                          <details className="group mt-3">
                            <summary className="cursor-pointer text-xs font-medium text-ink-500 hover:text-ink-800">Previous versions ({previous.length})</summary>
                            <div className="mt-2 space-y-2">
                              {previous.map((v) => (
                                <VersionCard key={v.id} v={v} />
                              ))}
                            </div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!locked && item.status !== "approved" && (
                <ActionForm action={staffUploadAction} resetOnSuccess className="border-t border-ink-100 px-5 py-4">
                  <input type="hidden" name="itemId" value={item.id} />
                  <label className="label" htmlFor="file">
                    Upload on the client's behalf
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input id="file" type="file" name="file" required className="input py-1.5 text-sm" accept={config.file?.accept.map((a) => "." + a).join(",")} />
                    <SubmitButton className="btn-secondary shrink-0" pendingText="Uploading…">
                      Upload
                    </SubmitButton>
                  </div>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Comments" padded={false}>
            <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2 border-b border-ink-100 p-4">
              <input type="hidden" name="onboardingId" value={item.onboarding_id} />
              <input type="hidden" name="itemId" value={item.id} />
              <textarea name="body" className="input min-h-[70px] text-sm" placeholder={item.audience === "client" ? "Message the client or add an internal note" : "Add an internal note"} required />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <select name="visibility" className="input w-auto py-1.5 text-sm" defaultValue="internal" aria-label="Visibility">
                  <option value="internal">Internal note (team only)</option>
                  {item.audience === "client" && <option value="client">Visible to client</option>}
                </select>
                <SubmitButton className="btn-primary px-3 py-1.5">Post</SubmitButton>
              </div>
            </ActionForm>
            <CommentList comments={data.comments} empty="No comments on this item." />
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          {!locked && item.kind === "task" && (
            <Card title="Task status">
              <ActionForm action={setTaskStatusAction} className="space-y-2">
                <input type="hidden" name="itemId" value={item.id} />
                <div className="grid grid-cols-3 gap-2">
                  <SubmitButton className={item.status === "not_started" ? "btn-primary" : "btn-secondary"} name="status" value="not_started">
                    To do
                  </SubmitButton>
                  <SubmitButton className={item.status === "in_progress" ? "btn-primary" : "btn-secondary"} name="status" value="in_progress">
                    Doing
                  </SubmitButton>
                  <SubmitButton
                    className={item.status === "approved" ? "btn-primary" : "btn-secondary"}
                    name="status"
                    value="approved"
                    disabled={unmet.length > 0}
                    title={unmet.length ? "Blocked by dependencies" : undefined}
                  >
                    Done
                  </SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}

          {!locked && item.kind !== "task" && (
            <Card title="Review">
              {item.status === "approved" ? (
                <ActionForm action={reopenItemAction} className="space-y-3">
                  <p className="flex items-center gap-2 text-sm text-emerald-700">
                    <ShieldCheck className="h-4 w-4" />
                    Approved{item.reviewed_by ? ` by ${staff.map.get(item.reviewed_by) ?? "a former member"}` : ""} {item.reviewed_at ? formatDate(item.reviewed_at) : ""}.
                  </p>
                  <input type="hidden" name="itemId" value={item.id} />
                  <SubmitButton className="btn-secondary">Reopen for changes</SubmitButton>
                </ActionForm>
              ) : (
                <div className="space-y-4">
                  {item.status === "submitted" && (
                    <ActionForm action={startReviewAction} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <input type="hidden" name="itemId" value={item.id} />
                      <p className="text-sm text-amber-900">
                        Submitted {item.submitted_at ? formatDateTime(item.submitted_at) : ""}. Start the review to lock it while you check it.
                      </p>
                      <SubmitButton className="btn-secondary mt-2 px-3 py-1.5 text-xs">Start review</SubmitButton>
                    </ActionForm>
                  )}
                  {item.status === "under_review" && (
                    <p className="text-sm text-violet-700">Under review{reviewerName ? ` by ${reviewerName}` : ""}. The client can't edit it until you respond.</p>
                  )}
                  {!awaiting && item.status !== "changes_requested" && (
                    <p className="text-xs text-ink-500">The client hasn't submitted this yet. You can still approve it if you received it another way.</p>
                  )}
                  {item.status === "changes_requested" && <p className="text-xs text-ink-500">Sent back to the client. Waiting for them to resubmit.</p>}
                  {auth.canApprove ? (
                    <ActionForm action={reviewItemAction} className="space-y-2">
                      <input type="hidden" name="itemId" value={item.id} />
                      <label className="label" htmlFor="review-note">
                        Message to the client
                      </label>
                      <textarea id="review-note" name="note" className="input min-h-[70px] text-sm" placeholder="Required when requesting changes. Visible in the client portal." />
                      <label className="label" htmlFor="review-internal">
                        Internal note <span className="font-normal text-ink-400">(optional, team only)</span>
                      </label>
                      <textarea id="review-internal" name="internalNote" className="input min-h-[50px] text-sm" />
                      <div className="grid grid-cols-2 gap-2">
                        <SubmitButton name="decision" value="approve" disabled={item.kind === "file" && data.documents.length === 0}>
                          Approve
                        </SubmitButton>
                        <SubmitButton className="btn-danger" name="decision" value="changes" disabled={!awaiting}>
                          Request changes
                        </SubmitButton>
                      </div>
                      {item.kind === "file" && !allDocsAccepted && data.documents.length > 0 && (
                        <p className="text-xs text-ink-500">Approving accepts any files still pending review.</p>
                      )}
                    </ActionForm>
                  ) : (
                    <p className="text-sm text-ink-500">You don't have approval permission. Reassign the review to someone who does.</p>
                  )}
                </div>
              )}
            </Card>
          )}

          {item.kind !== "task" && (
            <Card title="Reviewer">
              <p className="text-sm text-ink-700">{reviewerName ?? <span className="text-ink-400">No reviewer assigned{item.owner_user_id ? ` (falls back to ${staff.map.get(item.owner_user_id) ?? "the owner"})` : ""}</span>}</p>
              {!locked && can(auth.role, "reassignReviews") && (
                <ActionForm action={reassignReviewerAction} className="mt-3 flex gap-2">
                  <input type="hidden" name="itemId" value={item.id} />
                  <select name="reviewerId" className="input py-1.5 text-sm" defaultValue={item.reviewer_user_id ?? ""} aria-label="Reviewer">
                    <option value="">Unassigned</option>
                    {staff.list.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({ROLE_LABEL[s.role as keyof typeof ROLE_LABEL] ?? s.role})
                      </option>
                    ))}
                  </select>
                  <SubmitButton className="btn-secondary shrink-0 px-3 py-1.5 text-xs">Reassign</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Details">
            <ActionForm action={updateItemAction} className="space-y-3">
              <input type="hidden" name="itemId" value={item.id} />
              <div>
                <label className="label" htmlFor="dueDate">
                  Due date {isOverdue(item) && <span className="text-rose-700">(overdue)</span>}
                </label>
                <input id="dueDate" type="date" name="dueDate" className="input" defaultValue={item.due_at ? new Date(item.due_at).toISOString().slice(0, 10) : ""} disabled={locked} />
              </div>
              <div>
                <label className="label" htmlFor="ownerId">
                  Owner
                </label>
                <select id="ownerId" name="ownerId" className="input" defaultValue={item.owner_user_id ?? ""} disabled={locked}>
                  <option value="">Unassigned</option>
                  {staff.list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="required" defaultChecked={item.required} className="h-4 w-4 rounded" disabled={locked} /> Required for completion
              </label>
              {!locked && <SubmitButton className="btn-secondary">Save details</SubmitButton>}
            </ActionForm>
          </Card>

          {(deps.length > 0 || dependents.length > 0) && (
            <Card title="Dependencies">
              {deps.length > 0 && (
                <>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Waits on</p>
                  <ul className="mt-2 space-y-1.5">
                    {deps.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                        <Link href={`/app/clients/${id}/items/${d.id}`} className="link min-w-0 truncate">
                          {d.title}
                        </Link>
                        <StatusBadge status={d.status} task={d.kind === "task"} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {dependents.length > 0 && (
                <>
                  <p className={clsx("text-[11px] font-semibold uppercase tracking-wider text-ink-400", deps.length > 0 && "mt-4")}>Unblocks</p>
                  <ul className="mt-2 space-y-1.5">
                    {dependents.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                        <Link href={`/app/clients/${id}/items/${d.id}`} className="link min-w-0 truncate">
                          {d.title}
                        </Link>
                        <StatusBadge status={displayStatus(d, byKey)} task={d.kind === "task"} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          )}

          <Card title="Status history" padded={false}>
            {data.statusHistory.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No status changes recorded yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.statusHistory.map((h) => (
                  <li key={h.id} className="px-5 py-2.5 text-sm">
                    <p className="flex flex-wrap items-center gap-1.5 text-ink-800">
                      {h.from_status ? (
                        <>
                          <span className="text-ink-500">{STATUS_LABEL[h.from_status as ItemStatus] ?? h.from_status}</span>
                          <ArrowRight className="h-3 w-3 text-ink-400" />
                        </>
                      ) : (
                        <span className="text-ink-500">Created as</span>
                      )}
                      <span className="font-medium">{STATUS_LABEL[h.to_status as ItemStatus] ?? h.to_status}</span>
                    </p>
                    <p className="text-xs text-ink-500">
                      {h.actor ?? "System"}
                      {h.actor_role && h.actor_role !== "system" && ` (${ROLE_LABEL[h.actor_role as keyof typeof ROLE_LABEL] ?? h.actor_role})`} · {formatDateTime(h.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Activity" padded={false}>
            {data.activity.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No recorded activity yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.activity.map((h, i) => (
                  <li key={i} className="px-5 py-2.5 text-sm">
                    <p className="text-ink-800">{h.summary}</p>
                    <p className="text-xs text-ink-500">
                      {h.actor ?? "System"} · {formatDateTime(h.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {isManager && !closed && (
            <Card title="Requirement">
              {removed ? (
                <ActionForm action={restoreRequirementAction}>
                  <input type="hidden" name="itemId" value={item.id} />
                  <SubmitButton className="btn-secondary">Restore requirement</SubmitButton>
                </ActionForm>
              ) : (
                <ActionForm action={removeRequirementAction} confirm={`Remove "${item.title}" from this onboarding? The client will no longer see it.`} className="space-y-2">
                  <input type="hidden" name="itemId" value={item.id} />
                  <p className="text-xs text-ink-500">
                    Removing drops it from readiness and the client's checklist. History and files are kept.
                    {dependents.length > 0 && ` ${dependents.length} item${dependents.length === 1 ? "" : "s"} that wait on it will no longer be blocked by it.`}
                  </p>
                  <input name="reason" className="input py-1.5 text-sm" placeholder="Reason (recorded in the audit log)" />
                  <SubmitButton className="btn-danger">
                    <Trash2 className="h-4 w-4" /> Remove from onboarding
                  </SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
          {closed && (
            <p className="flex items-center gap-1.5 text-xs text-ink-500">
              <Lock className="h-3.5 w-3.5" /> This onboarding is {item.onboarding_status}; the item is read-only.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function VersionCard({ v, latest = false }: { v: VersionRow; latest?: boolean }) {
  return (
    <div className={clsx("mt-2 rounded-lg border p-3", latest ? "border-ink-200 bg-white" : "border-ink-100 bg-ink-50/60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="break-words">
            <span className="font-medium">v{v.version}</span> · {v.original_name} · {formatBytes(v.size_bytes)}
            {latest && <span className="ml-2 text-xs font-medium text-brand-700">Latest</span>}
          </p>
          <p className="text-xs text-ink-500">
            Uploaded by {v.uploader ?? "Unknown"}
            {v.uploader_role === "client" ? " (client)" : v.uploader_role ? " (team)" : ""} · {formatDateTime(v.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ScanBadge status={v.scan_status} />
          <DocReviewBadge status={v.review_status} />
          <ExpiryBadge expiresOn={v.expires_on} />
          {v.purged_at ? (
            <Badge>Deleted by retention</Badge>
          ) : (
            <a href={`/api/files/link?v=${v.id}`} className="btn-secondary px-2.5 py-1 text-xs" title="Opens a signed link that expires in five minutes">
              Download
            </a>
          )}
        </div>
      </div>
      {v.scan_status === "not_scanned" && <p className="mt-2 text-xs text-amber-800">{SCAN_NOT_CONFIGURED}</p>}
      {v.scan_detail && v.scan_status !== "not_scanned" && v.scan_status !== "clean" && <p className="mt-2 text-xs text-rose-700">Scanner: {v.scan_detail}</p>}
      {(v.review_note || v.reviewed_at) && (
        <p className="mt-2 text-xs text-ink-600">
          {v.reviewer && v.reviewed_at && `Reviewed by ${v.reviewer} · ${formatDateTime(v.reviewed_at)}`}
          {v.review_note && <span className="block">Note: {v.review_note}</span>}
        </p>
      )}
    </div>
  );
}
