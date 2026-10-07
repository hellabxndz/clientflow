import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";
import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { displayStatus, unmetDependencies, isOverdue, type ItemLike } from "@/lib/onboarding";
import { Notice, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ReviewBadge, formatBytes } from "@/components/files";
import { formatDate, formatDateTime } from "@/lib/time";
import { clientCommentAction, clientUploadAction } from "../../actions";
import { portalBrand } from "../../brand";
import { ItemForm, type ItemConfig } from "./item-form";

export const metadata = { title: "Request" };

type Version = { document_id: string; title: string; version_id: string; version: number; original_name: string; size_bytes: number; review_status: string; review_note: string | null; created_at: Date; purged_at: Date | null };

export default async function PortalItemPage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireClient();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const item = await tx.one<ItemLike & {
      onboarding_id: string; description: string | null; response: Record<string, unknown>; onboarding_status: string; timezone: string; config: ItemConfig;
    }>(
      `select i.id, i.item_key, i.title, i.description, i.kind, i.audience, i.required, i.status, i.due_at, i.owner_user_id, i.depends_on,
              i.section_title, i.submitted_at, i.reviewed_at, i.removed_at, i.config, i.response, i.onboarding_id,
              o.status as onboarding_status, c.timezone
       from onboarding_items i join onboardings o on o.id = i.onboarding_id join clients c on c.id = i.client_id
       where i.id = $1 and i.client_id = $2 and i.audience = 'client' and i.removed_at is null`,
      [id, auth.clientId],
    );
    if (!item) return null;
    const siblings = await tx.q<ItemLike>(
      "select id, item_key, title, kind, audience, required, status, due_at, owner_user_id, depends_on, section_title, removed_at from onboarding_items where onboarding_id = $1 and audience = 'client'",
      [item.onboarding_id],
    );
    const versions = await tx.q<Version>(
      `select d.id as document_id, d.title, v.id as version_id, v.version, v.original_name, v.size_bytes::int, v.review_status, v.review_note, v.created_at, v.purged_at
       from documents d join document_versions v on v.document_id = d.id where d.item_id = $1 order by d.created_at, d.id, v.version desc`,
      [id],
    );
    const comments = await tx.q<{ id: string; body: string; created_at: Date; author: string | null; mine: boolean; from_team: boolean }>(
      `select c.id, c.body, c.created_at, u.name as author, c.author_user_id = $2 as mine,
              (c.author_user_id is null or not exists (select 1 from memberships m where m.user_id = c.author_user_id and m.role = 'client')) as from_team
       from comments c left join users u on u.id = c.author_user_id where c.item_id = $1 and c.visibility = 'client' order by c.created_at`,
      [id, auth.user.id],
    );
    return { item, siblings, versions, comments };
  });
  if (!data) notFound();

  const { item } = data;
  const ws = auth.workspace;
  const brand = portalBrand(ws);
  const tz = item.timezone;
  const byKey = new Map(data.siblings.map((s) => [s.item_key, s]));
  const blocked = unmetDependencies(item, byKey);
  const status = displayStatus(item, byKey);
  const closed = item.onboarding_status === "completed" || item.onboarding_status === "cancelled";
  const locked = item.status === "approved" || item.status === "under_review" || closed || blocked.length > 0;

  // Group versions by document; newest version first.
  const docs = new Map<string, Version[]>();
  for (const v of data.versions) docs.set(v.document_id, [...(docs.get(v.document_id) ?? []), v]);
  const docList = [...docs.values()];

  const teamComments = data.comments.filter((c) => c.from_team);
  const lastTeamComment = teamComments[teamComments.length - 1];
  const rejectedNotes = docList.map((vs) => vs[0]).filter((v) => v.review_status === "changes_requested" || v.review_status === "rejected").map((v) => v.review_note).filter((n): n is string => !!n);
  const fileRules = item.config.file;
  const maxMb = Math.min(fileRules?.maxSizeMb ?? 25, ws.max_upload_mb);
  const accept = fileRules?.accept.map((a) => "." + a).join(",");
  const access = item.kind === "access" ? item.config.access : undefined;
  const wasSentBack = item.status === "in_progress" && !!item.reviewed_at;

  return (
    <div className="space-y-5">
      <Link href="/portal" className="inline-flex min-h-[40px] items-center gap-1 text-sm text-ink-500 hover:text-ink-800">
        <ArrowLeft className="h-4 w-4" /> Back to your checklist
      </Link>
      <div>
        <p className="text-sm font-medium" style={{ color: "var(--brand)" }}>{item.section_title}</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-ink-900">{item.title}</h1>
          <StatusBadge status={status} className="mt-1" />
        </div>
        <p className="mt-1 text-sm text-ink-500">
          {item.required ? "Required" : "Optional"}
          {item.due_at && item.status !== "approved" && (
            <span className={isOverdue(item) ? "font-medium text-rose-700" : undefined}> · {isOverdue(item) ? "Overdue, was due" : "Due"} {formatDate(item.due_at, tz)}</span>
          )}
        </p>
        {item.description && <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-ink-700">{item.description}</p>}
      </div>

      {item.status === "changes_requested" && (
        <div className="rounded-xl border-2 border-rose-200 bg-rose-50 p-4">
          <p className="font-semibold text-rose-900">Changes requested</p>
          {rejectedNotes.map((n, i) => <p key={i} className="mt-1 whitespace-pre-line text-[15px] text-rose-900">{n}</p>)}
          {lastTeamComment && (
            <p className="mt-1 whitespace-pre-line text-[15px] text-rose-900">
              {lastTeamComment.body}
              <span className="mt-1 block text-xs text-rose-700">— {lastTeamComment.author ?? brand.company}, {formatDateTime(lastTeamComment.created_at, tz)}</span>
            </p>
          )}
          {!lastTeamComment && rejectedNotes.length === 0 && <p className="mt-1 text-sm text-rose-900">The team asked for a few changes. Ask below if anything is unclear.</p>}
          <p className="mt-2 text-sm text-rose-800">Update it below and submit again.</p>
        </div>
      )}
      {wasSentBack && lastTeamComment && (
        <Notice tone="warning" title="Feedback from the team">{lastTeamComment.body}</Notice>
      )}
      {item.status === "submitted" && <Notice tone="info" title="Submitted">The team will review this soon. You can still make changes until they start reviewing.</Notice>}
      {item.status === "under_review" && <Notice tone="info" title="Under review">The team is reviewing this now, so it's read-only. We'll let you know if anything needs to change.</Notice>}
      {item.status === "approved" && <Notice tone="success" title="Approved">Thanks, this one is done.</Notice>}
      {blocked.length > 0 && (
        <Notice tone="warning" title="Blocked: waiting on an earlier step">
          This opens once {blocked.map((b) => `“${b.title}”`).join(" and ")} {blocked.length > 1 ? "are" : "is"} approved.
        </Notice>
      )}
      {closed && <Notice tone="info">This onboarding is closed, so this item can no longer be changed.</Notice>}

      {access && (
        <section className="card">
          <div className="border-b border-ink-100 px-5 py-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Platform</p>
            <h2 className="text-[15px] font-semibold text-ink-900">{access.platform}</h2>
          </div>
          <div className="space-y-4 p-5">
            <ol className="space-y-2">
              {splitSteps(access.instructions).map((s, i) => (
                <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-ink-800">
                  {s.numbered && (
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: "var(--brand)" }}>{s.n}</span>
                  )}
                  <span className={s.numbered ? undefined : "text-sm text-ink-600"}>{s.text}</span>
                </li>
              ))}
            </ol>
            <dl className="grid gap-3 rounded-lg bg-ink-50 p-4 text-sm sm:grid-cols-2">
              {(access.inviteEmail || ws.support_email) && (
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Invite this email</dt>
                  <dd className="mt-0.5 break-all font-medium text-ink-900">{access.inviteEmail || ws.support_email}</dd>
                </div>
              )}
              {access.accessLevel && (
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Access level</dt>
                  <dd className="mt-0.5 font-medium text-ink-900">{access.accessLevel}</dd>
                </div>
              )}
            </dl>
            {access.helpUrl && /^https?:\/\//.test(access.helpUrl) && (
              <a href={access.helpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[40px] items-center text-sm font-medium hover:underline" style={{ color: "var(--brand)" }}>
                {access.platform} help article ↗
              </a>
            )}
            <p className="text-xs text-ink-500">You stay in control: you can remove this access at any time. We will never ask for your password.</p>
          </div>
        </section>
      )}

      {item.kind === "file" && (
        <section className="card">
          <div className="border-b border-ink-100 px-5 py-3.5">
            <h2 className="text-[15px] font-semibold text-ink-900">Your files</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              Accepted: {fileRules?.accept.map((a) => "." + a).join(", ")} · up to {maxMb} MB each{fileRules?.maxFiles ? ` · up to ${fileRules.maxFiles} files` : ""}
            </p>
          </div>
          {docList.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-500">Nothing uploaded yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {docList.map((vs) => {
                const d = vs[0];
                const older = vs.slice(1);
                return (
                  <li key={d.document_id} className="px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink-900">{d.original_name}</p>
                        <p className="text-xs text-ink-500">Version {d.version} · {formatBytes(d.size_bytes)} · {formatDateTime(d.created_at, tz)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <ReviewBadge status={d.review_status} />
                        {!d.purged_at && <a href={`/api/files/link?v=${d.version_id}`} className="btn-secondary min-h-[36px] px-3 py-1 text-xs">View</a>}
                      </div>
                    </div>
                    {d.review_note && (d.review_status === "changes_requested" || d.review_status === "rejected") && <p className="mt-1 text-sm text-rose-700">{d.review_note}</p>}
                    {older.length > 0 && (
                      <details className="mt-2">
                        <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-ink-500"><History className="h-3 w-3" /> {older.length} previous version{older.length === 1 ? "" : "s"}</summary>
                        <ul className="mt-2 space-y-1.5 border-l-2 border-ink-100 pl-3">
                          {older.map((v) => (
                            <li key={v.version_id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
                              <span className="min-w-0 truncate">v{v.version} · {v.original_name} · {formatDateTime(v.created_at, tz)}</span>
                              <span className="flex items-center gap-2">
                                <ReviewBadge status={v.review_status} />
                                {v.purged_at ? <span>Deleted</span> : <a href={`/api/files/link?v=${v.version_id}`} className="link">View</a>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {!locked && (
                      <ActionForm action={clientUploadAction} className="mt-3">
                        <input type="hidden" name="itemId" value={item.id} />
                        <input type="hidden" name="documentId" value={d.document_id} />
                        <details open={d.review_status === "changes_requested" || d.review_status === "rejected"}>
                          <summary className="cursor-pointer text-sm font-medium" style={{ color: "var(--brand)" }}>Replace with a new version</summary>
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                            <input type="file" name="file" required className="input py-2 text-sm" accept={accept} />
                            <SubmitButton className="btn-secondary min-h-[44px] shrink-0" pendingText="Uploading…">Upload new version</SubmitButton>
                          </div>
                        </details>
                      </ActionForm>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!locked && (!fileRules?.maxFiles || docList.length < fileRules.maxFiles) && (
            <ActionForm action={clientUploadAction} resetOnSuccess className="border-t border-ink-100 p-5">
              <input type="hidden" name="itemId" value={item.id} />
              <label className="label" htmlFor="file">{docList.length ? "Add another file" : "Add a file"}</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="file" type="file" name="file" required className="input py-2 text-sm" accept={accept} />
                <SubmitButton className="btn-secondary min-h-[44px] shrink-0" pendingText="Uploading…">Upload</SubmitButton>
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
          hasFiles={docList.length > 0}
          status={item.status}
        />
      )}

      <section id="comments" className="card scroll-mt-20">
        <div className="border-b border-ink-100 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink-900">Questions or comments</h2>
        </div>
        {data.comments.length > 0 ? (
          <ul className="divide-y divide-ink-100">
            {data.comments.map((c) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-700">{c.mine ? "You" : c.author ?? brand.company}</span>
                  <span className="shrink-0 text-ink-400">{formatDateTime(c.created_at, tz)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line break-words text-sm text-ink-700">{c.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-ink-500">No comments yet. Ask the team anything about this item.</p>
        )}
        {!closed && (
          <ActionForm action={clientCommentAction} resetOnSuccess className="space-y-2 border-t border-ink-100 p-4">
            <input type="hidden" name="onboardingId" value={item.onboarding_id} />
            <input type="hidden" name="itemId" value={item.id} />
            <textarea name="body" className="input min-h-[80px] text-[15px]" placeholder="Ask the team about this item" required maxLength={5000} />
            <SubmitButton className="btn-secondary min-h-[44px] w-full sm:w-auto" pendingText="Sending…">Send</SubmitButton>
          </ActionForm>
        )}
      </section>
    </div>
  );
}

/** Turns "1. Do this.\n2. Then that.\n\nNote" into numbered steps plus trailing notes. */
function splitSteps(text: string) {
  const out: { n: number; text: string; numbered: boolean }[] = [];
  let n = 0;
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (m) out.push({ n: ++n, text: m[2], numbered: true });
    else out.push({ n: 0, text: line, numbered: false });
  }
  return out;
}
