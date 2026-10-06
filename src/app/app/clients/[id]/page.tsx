import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { loadOnboardings, staffNames } from "@/lib/queries";
import { explainBlockers, isOverdue, unmetDependencies } from "@/lib/onboarding";
import { Avatar, Badge, Card, EmptyState, Notice, PageHeader, Progress, StageBadge, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate, formatDateTime } from "@/lib/time";
import { aiStatus } from "@/lib/ai";
import { emailConnection } from "@/lib/email";
import {
  addCommentAction,
  addQuestionAction,
  addTaskAction,
  approveCompletionAction,
  inviteContactAction,
  removeMemberAction,
  revokeInvitationAction,
  setOnboardingStatusAction,
  startOnboardingAction,
  toggleOnboardingRemindersAction,
} from "../../actions";
import { AiPanel } from "./ai-panel";
import { InviteContactForm } from "./invite-form";
import { KindIcon, KIND_LABEL } from "@/components/kind";

export const metadata = { title: "Client" };

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ o?: string }> }) {
  const auth = await requireStaff();
  const { id } = await params;
  const { o: selected } = await searchParams;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const client = await tx.one<{ id: string; name: string; industry: string | null; website: string | null; timezone: string; primary_contact_name: string | null; primary_contact_email: string | null }>(
      "select * from clients where id = $1",
      [id],
    );
    if (!client) return null;
    const onboardings = await loadOnboardings(tx, "o.client_id = $1", [id]);
    const staff = await staffNames(tx);
    const contacts = await tx.q<{ membership_id: string; name: string; email: string; last_login_at: Date | null }>(
      `select m.id as membership_id, u.name, u.email, null::timestamptz as last_login_at from memberships m join users u on u.id = m.user_id
       where m.role = 'client' and m.client_id = $1 order by u.name`,
      [id],
    );
    const invites = await tx.q<{ id: string; email: string; expires_at: Date; expired: boolean }>(
      `select id, email, expires_at, expires_at < now() as expired from invitations
       where client_id = $1 and accepted_at is null and revoked_at is null order by created_at desc`,
      [id],
    );
    const current = onboardings.find((o) => o.id === selected) ?? onboardings[0];
    const comments = current
      ? await tx.q<{ id: string; body: string; visibility: string; created_at: Date; author: string | null; author_role: string | null; item_title: string | null }>(
          `select c.id, c.body, c.visibility, c.created_at, u.name as author, m.role as author_role, i.title as item_title
           from comments c left join users u on u.id = c.author_user_id left join memberships m on m.user_id = c.author_user_id
           left join onboarding_items i on i.id = c.item_id
           where c.onboarding_id = $1 order by c.created_at desc limit 30`,
          [current.id],
        )
      : [];
    const emails = current
      ? await tx.q<{ id: string; subject: string; status: string; to_email: string; created_at: Date; error: string | null; kind: string }>(
          "select id, subject, status, to_email, created_at, error, kind from email_messages where onboarding_id = $1 order by created_at desc limit 10",
          [current.id],
        )
      : [];
    const templates = await tx.q<{ id: string; name: string; current_version: number }>(
      "select id, name, current_version from templates where archived = false and current_version > 0 order by name",
    );
    return { client, onboardings, current, staff, contacts, invites, comments, emails, templates };
  });
  if (!data) notFound();
  const { client, current, staff } = data;
  const ai = aiStatus(auth.workspace);
  const email = emailConnection(auth.workspace);

  const sections = new Map<string, NonNullable<typeof current>["items"]>();
  for (const item of current?.items ?? []) {
    const list = sections.get(item.section_title) ?? [];
    list.push(item);
    sections.set(item.section_title, list);
  }
  const byKey = new Map((current?.items ?? []).map((i) => [i.item_key, i]));

  return (
    <>
      <div className="mb-2 text-sm"><Link href="/app/clients" className="text-ink-500 hover:text-ink-800">← Clients</Link></div>
      <PageHeader
        title={client.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {current && <StageBadge stage={current.state.stage} />}
            <span>{[client.industry, client.primary_contact_name, client.timezone].filter(Boolean).join(" · ")}</span>
          </span>
        }
        actions={
          current && current.status !== "completed" && current.status !== "cancelled" ? (
            <>
              <ActionForm action={setOnboardingStatusAction} showSuccess={false}>
                <input type="hidden" name="onboardingId" value={current.id} />
                <input type="hidden" name="status" value={current.status === "paused" ? "active" : "paused"} />
                <SubmitButton className="btn-secondary">{current.status === "paused" ? "Resume onboarding" : "Pause onboarding"}</SubmitButton>
              </ActionForm>
            </>
          ) : null
        }
      />

      {!current ? (
        <Card title="Start an onboarding">
          <ActionForm action={startOnboardingAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="clientId" value={client.id} />
            <div className="flex-1">
              <label className="label" htmlFor="templateId">Template</label>
              <select id="templateId" name="templateId" className="input">
                {data.templates.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.current_version})</option>)}
              </select>
            </div>
            <SubmitButton>Start onboarding</SubmitButton>
          </ActionForm>
        </Card>
      ) : (
        <>
          {data.onboardings.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2 text-sm">
              {data.onboardings.map((o) => (
                <Link key={o.id} href={`/app/clients/${client.id}?o=${o.id}`} className={clsx("rounded-full px-3 py-1 ring-1", o.id === current.id ? "bg-brand-50 font-medium text-brand-800 ring-brand-200" : "text-ink-600 ring-ink-200")}>
                  {o.name} · {formatDate(o.created_at)}
                </Link>
              ))}
            </div>
          )}

          {current.status === "paused" && (
            <Notice tone="warning" className="mb-6" title="Onboarding paused">
              No reminders are sent while paused. The client can still see their checklist.
            </Notice>
          )}
          {current.status === "completed" && (
            <Notice tone="success" className="mb-6" title="Onboarding complete">
              Approved on {formatDate(current.completed_at)}. All required items were accepted.
            </Notice>
          )}
          {current.state.readyForCompletion && current.status === "active" && (
            <div className="mb-6 rounded-xl border border-brand-200 bg-brand-50 p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-brand-900">All required items are approved</p>
                  <p className="text-sm text-brand-900/80">An authorized team member can approve completion so the client is marked ready to start.</p>
                </div>
                {auth.canApprove ? (
                  <ActionForm action={approveCompletionAction} confirm="Approve this onboarding as complete?">
                    <input type="hidden" name="onboardingId" value={current.id} />
                    <SubmitButton pendingText="Approving…">Approve completion</SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-brand-900">You don't have completion approval permission.</p>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-3">
            <div className="min-w-0 space-y-6 xl:col-span-2">
              <div className="card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-ink-500">
                      {current.template_name} · <span className="font-medium text-ink-700">template v{current.template_version}</span> · started {formatDate(current.start_date)} · owner {current.owner_name ?? "unassigned"}
                    </p>
                  </div>
                  <p className="text-sm font-medium">{current.state.progress.requiredApproved}/{current.state.progress.requiredTotal} required approved</p>
                </div>
                <Progress value={current.state.progress.percent} className="mt-3" />
              </div>

              {[...sections.entries()].map(([section, items]) => (
                <Card key={section} title={section} padded={false}>
                  <ul className="divide-y divide-ink-100">
                    {items.map((item) => {
                      const deps = unmetDependencies(item, byKey);
                      const overdue = isOverdue(item);
                      return (
                        <li key={item.id}>
                          <Link href={`/app/clients/${client.id}/items/${item.id}`} className="flex flex-col gap-2 px-5 py-3.5 hover:bg-ink-50 sm:flex-row sm:items-center sm:gap-4">
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <KindIcon kind={item.kind} />
                              <div className="min-w-0">
                                <p className="font-medium text-ink-900">
                                  {item.title}
                                  {!item.required && <span className="ml-2 text-xs font-normal text-ink-400">Optional</span>}
                                </p>
                                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                                  <span>{KIND_LABEL[item.kind as keyof typeof KIND_LABEL]}</span>
                                  {item.audience === "internal" && <Badge tone="brand">Internal</Badge>}
                                  {deps.length > 0 && <span className="text-amber-700">Blocked by {deps.map((d) => d.title).join(", ")}</span>}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 pl-8 sm:pl-0">
                              {item.due_at && <span className={clsx("whitespace-nowrap text-xs", overdue ? "font-medium text-rose-700" : "text-ink-500")}>{overdue ? "Overdue · " : "Due "}{formatDate(item.due_at)}</span>}
                              {item.owner_user_id && <span title={staff.map.get(item.owner_user_id)}><Avatar name={staff.map.get(item.owner_user_id) ?? "?"} /></span>}
                              <StatusBadge status={item.status} task={item.kind === "task"} />
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ))}

              {current.status !== "completed" && (
                <div className="grid gap-6 lg:grid-cols-2">
                  <Card title="Ask the client a question">
                    <ActionForm action={addQuestionAction} resetOnSuccess className="space-y-3">
                      <input type="hidden" name="onboardingId" value={current.id} />
                      <textarea name="question" className="input min-h-[80px]" placeholder="e.g. Which location should we focus on first?" required />
                      <div className="flex flex-wrap items-center gap-3">
                        <input type="date" name="dueDate" className="input w-auto" aria-label="Due date" />
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded" /> Required</label>
                      </div>
                      <SubmitButton pendingText="Adding…">Add to client checklist</SubmitButton>
                    </ActionForm>
                  </Card>
                  <Card title="Add an internal task">
                    <ActionForm action={addTaskAction} resetOnSuccess className="space-y-3">
                      <input type="hidden" name="onboardingId" value={current.id} />
                      <input name="title" className="input" placeholder="Task title" required />
                      <div className="grid grid-cols-2 gap-3">
                        <select name="ownerId" className="input" defaultValue={auth.user.id} aria-label="Owner">
                          <option value="">Unassigned</option>
                          {staff.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                        <input type="date" name="dueDate" className="input" aria-label="Due date" />
                      </div>
                      <details>
                        <summary className="cursor-pointer text-sm text-ink-600">Depends on…</summary>
                        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                          {current.items.map((i) => (
                            <label key={i.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="dependsOn" value={i.item_key} className="h-4 w-4 rounded" /> {i.title}</label>
                          ))}
                        </div>
                      </details>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded" /> Required for completion</label>
                      <SubmitButton pendingText="Adding…">Add task</SubmitButton>
                    </ActionForm>
                  </Card>
                </div>
              )}
            </div>

            <div className="space-y-6">
              <Card title="Why it's blocked">
                <ul className="space-y-2 text-sm text-ink-700">
                  {explainBlockers(current.state.blockers, staff.map).map((line, i) => <li key={i}>{line}</li>)}
                  {current.status === "paused" && <li>The onboarding is paused.</li>}
                </ul>
              </Card>

              <Card title="Assistant">
                <AiPanel onboardingId={current.id} aiAvailable={ai.available} aiReason={ai.reason} emailMode={email.mode} />
                <p className="mt-3 text-xs text-ink-500">Suggestions only. AI never approves items or documents.</p>
              </Card>

              <Card title="Messages and notes" padded={false}>
                <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2 border-b border-ink-100 p-4">
                  <input type="hidden" name="onboardingId" value={current.id} />
                  <textarea name="body" className="input min-h-[70px] text-sm" placeholder="Write a message or note" required />
                  <div className="flex items-center justify-between gap-2">
                    <select name="visibility" className="input w-auto py-1.5 text-sm" aria-label="Visibility">
                      <option value="internal">Internal note (team only)</option>
                      <option value="client">Message to client</option>
                    </select>
                    <SubmitButton className="btn-primary px-3 py-1.5">Post</SubmitButton>
                  </div>
                </ActionForm>
                {data.comments.length === 0 ? (
                  <p className="p-4 text-sm text-ink-500">No messages yet.</p>
                ) : (
                  <ul className="max-h-[420px] divide-y divide-ink-100 overflow-y-auto">
                    {data.comments.map((c) => (
                      <li key={c.id} className={clsx("px-4 py-3", c.visibility === "internal" && "bg-amber-50/50")}>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-ink-800">{c.author ?? "Former member"}{c.author_role === "client" && <span className="ml-1 text-ink-400">(client)</span>}</span>
                          <span className="text-ink-400">{formatDateTime(c.created_at)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-line text-sm text-ink-700">{c.body}</p>
                        <p className="mt-1 text-xs text-ink-400">
                          {c.visibility === "internal" ? "Internal note" : "Visible to client"}
                          {c.item_title && ` · ${c.item_title}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Client contacts">
                {data.contacts.length === 0 && data.invites.length === 0 && <p className="text-sm text-ink-500">No one from {client.name} has portal access yet.</p>}
                <ul className="space-y-3">
                  {data.contacts.map((c) => (
                    <li key={c.membership_id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium">{c.name}</p>
                        <p className="truncate text-xs text-ink-500">{c.email}</p>
                      </div>
                      {auth.role === "admin" && (
                        <ActionForm action={removeMemberAction} confirm={`Remove ${c.name}'s portal access and sign them out?`} showSuccess={false}>
                          <input type="hidden" name="memberId" value={c.membership_id} />
                          <SubmitButton className="btn-ghost px-2 py-1 text-xs text-rose-700">Remove</SubmitButton>
                        </ActionForm>
                      )}
                    </li>
                  ))}
                  {data.invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{i.email}</p>
                        <p className="text-xs text-ink-500">{i.expired ? "Invitation expired" : `Invited · expires ${formatDate(i.expires_at)}`}</p>
                      </div>
                      <ActionForm action={revokeInvitationAction} showSuccess={false}>
                        <input type="hidden" name="invitationId" value={i.id} />
                        <SubmitButton className="btn-ghost px-2 py-1 text-xs">Revoke</SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 border-t border-ink-100 pt-4">
                  <InviteContactForm clientId={client.id} defaultEmail={data.contacts.length === 0 ? client.primary_contact_email ?? "" : ""} />
                </div>
              </Card>

              <Card title="Reminders" padded={false}>
                <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 text-sm">
                  <span>{current.reminders_enabled ? "Automatic reminders on" : "Automatic reminders off"}</span>
                  {current.status !== "completed" && (
                    <ActionForm action={toggleOnboardingRemindersAction} showSuccess={false}>
                      <input type="hidden" name="onboardingId" value={current.id} />
                      <input type="hidden" name="enabled" value={current.reminders_enabled ? "false" : "true"} />
                      <SubmitButton className="btn-secondary px-3 py-1 text-xs">{current.reminders_enabled ? "Turn off" : "Turn on"}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
                {data.emails.length === 0 ? (
                  <p className="p-4 text-sm text-ink-500">No emails yet. <Link href="/app/settings/reminders" className="link">Reminder rules</Link></p>
                ) : (
                  <ul className="divide-y divide-ink-100">
                    {data.emails.map((e) => (
                      <li key={e.id} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{e.subject}</span>
                          <Badge tone={e.status === "sent" ? "success" : e.status === "failed" ? "danger" : e.status === "simulated" ? "brand" : "neutral"}>{e.status === "simulated" ? "demo" : e.status}</Badge>
                        </div>
                        <p className="text-xs text-ink-500">{e.to_email} · {formatDateTime(e.created_at)}{e.error && ` · ${e.error}`}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
      {data.onboardings.length === 0 && data.templates.length === 0 && <EmptyState title="No published templates" description="Publish a template first." />}
    </>
  );
}
