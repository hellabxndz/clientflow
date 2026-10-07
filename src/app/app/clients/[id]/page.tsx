import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { AlertTriangle, CalendarDays, Check, ChevronRight, Clock, Flag, Hourglass, Info, Lock, Pause, Play, Rocket, UserPlus } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { formatMoney, loadOnboardings, staffNames, type LoadedOnboarding } from "@/lib/queries";
import { BLOCKER_LABEL, displayStatus, explainBlockers, isOverdue, unmetDependencies, type Blocker, type ItemLike } from "@/lib/onboarding";
import { clientTimeline } from "@/lib/timeline";
import { planTemplateUpgrade, SENSITIVE_CATEGORIES, type UpgradePlan } from "@/lib/templates";
import { ASSIST_LABEL, aiStatus } from "@/lib/ai";
import { emailConnection } from "@/lib/email";
import { formatDate, formatDateTime } from "@/lib/time";
import { AtRiskBadge, Avatar, Badge, Card, EmptyState, Meta, Notice, ReadinessRing, StageBadge, StatusBadge, Tabs, WaitingOnBadge, readinessTone } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KindIcon, KIND_LABEL } from "@/components/kind";
import { formatBytes, ScanBadge } from "@/components/files";
import {
  addCommentAction,
  addQuestionAction,
  addTaskAction,
  applyTemplateUpgradeAction,
  approveCompletionAction,
  markReadyForKickoffAction,
  removeMemberAction,
  restoreRequirementAction,
  revokeInvitationAction,
  setAtRiskAction,
  setKickoffDateAction,
  setOnboardingStatusAction,
  startOnboardingAction,
  toggleOnboardingRemindersAction,
} from "../../actions";
import { AiPanel } from "./ai-panel";
import { InviteContactForm } from "./invite-form";
import { CommentList, DocReviewBadge, ExpiryBadge, SCAN_NOT_CONFIGURED, TimelineList, type CommentRow } from "./shared";

export const metadata = { title: "Client" };

const TABS = ["requirements", "timeline", "documents", "contacts", "activity"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { requirements: "Requirements", timeline: "Timeline", documents: "Documents", contacts: "Contacts", activity: "Activity" };
const WAITING_TEXT = { client: "Client", staff: "Staff", integration: "Integration" } as const;
const CONTACT_ROLE: Record<string, string> = { primary: "Primary", billing: "Billing", marketing: "Marketing", approver: "Approver", other: "Contact" };

interface ClientRow {
  id: string;
  name: string;
  industry: string | null;
  website: string | null;
  timezone: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  client_type_name: string | null;
  deal_amount: string | null;
  deal_recurrence: "one_time" | "monthly" | "annual";
  source: string;
}

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ o?: string; tab?: string }> }) {
  const auth = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "requirements";
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const client = await tx.one<ClientRow>(
      `select c.id, c.name, c.industry, c.website, c.timezone, c.primary_contact_name, c.primary_contact_email, c.owner_user_id, u.name as owner_name,
              ct.name as client_type_name, c.deal_amount::text, c.deal_recurrence, c.source
       from clients c left join users u on u.id = c.owner_user_id left join client_types ct on ct.id = c.client_type_id where c.id = $1`,
      [id],
    );
    if (!client) return null;
    const onboardings = await loadOnboardings(tx, "o.client_id = $1", [id], {
      leadDays: auth.workspace.kickoff_lead_days,
      businessDays: auth.workspace.business_days,
    });
    const current = onboardings.find((o) => o.id === sp.o) ?? onboardings.find((o) => o.status === "active" || o.status === "paused") ?? onboardings[0];
    const staff = await staffNames(tx);
    const comments = current
      ? await tx.q<CommentRow>(
          `select c.id, c.body, c.visibility, c.created_at, c.source, u.name as author, m.role as author_role, i.title as item_title
           from comments c left join users u on u.id = c.author_user_id left join memberships m on m.user_id = c.author_user_id
           left join onboarding_items i on i.id = c.item_id
           where c.onboarding_id = $1 order by c.created_at desc limit 40`,
          [current.id],
        )
      : [];
    const emails = current
      ? await tx.q<{ id: string; subject: string; status: string; to_email: string; created_at: Date; error: string | null; status_reason: string | null }>(
          "select id, subject, status, to_email, created_at, error, status_reason from email_messages where onboarding_id = $1 order by created_at desc limit 6",
          [current.id],
        )
      : [];
    const templates = await tx.q<{ id: string; name: string; current_version: number }>(
      "select id, name, current_version from templates where archived = false and current_version > 0 order by name",
    );
    let latestVersion: number | null = null;
    let plan: UpgradePlan | null = null;
    if (current?.template_id) {
      latestVersion = (await tx.one<{ v: number | null }>("select max(version)::int as v from template_versions where template_id = $1", [current.template_id]))?.v ?? null;
      if (latestVersion && current.template_version && latestVersion > current.template_version && (current.status === "active" || current.status === "paused"))
        plan = await planTemplateUpgrade(tx, current.id);
    }
    const docCounts = current
      ? new Map(
          (
            await tx.q<{ item_id: string; n: number }>("select item_id, count(*)::int as n from documents where onboarding_id = $1 group by item_id", [current.id])
          ).map((r) => [r.item_id, r.n]),
        )
      : new Map<string, number>();

    const timeline = tab === "timeline" ? await clientTimeline(tx, id) : [];
    const documents =
      tab === "documents"
        ? await tx.q<{
            version_id: string; document_id: string; title: string; version: number; versions: number; size_bytes: number; scan_status: string;
            review_status: string; expires_on: string | null; created_at: Date; item_id: string; item_title: string; category: string | null;
            uploader: string | null; purged_at: Date | null;
          }>(
            `select distinct on (d.id) v.id as version_id, d.id as document_id, d.title, v.version,
                    (select count(*)::int from document_versions x where x.document_id = d.id) as versions, v.size_bytes::int, v.scan_status,
                    v.review_status, v.expires_on::text, v.created_at, i.id as item_id, i.title as item_title, coalesce(d.category, i.category) as category,
                    u.name as uploader, v.purged_at
             from documents d join document_versions v on v.document_id = d.id join onboarding_items i on i.id = d.item_id
             left join users u on u.id = v.uploaded_by where d.client_id = $1 order by d.id, v.version desc`,
            [id],
          )
        : [];
    const contacts =
      tab === "contacts"
        ? {
            people: await tx.q<{ id: string; name: string; email: string | null; title: string | null; contact_role: string; phone: string | null }>(
              "select id, name, email, title, contact_role, phone from client_contacts where client_id = $1 order by contact_role = 'primary' desc, name",
              [id],
            ),
            portal: await tx.q<{ membership_id: string; name: string; email: string }>(
              `select m.id as membership_id, u.name, u.email from memberships m join users u on u.id = m.user_id
               where m.role = 'client' and m.client_id = $1 order by u.name`,
              [id],
            ),
            invites: await tx.q<{ id: string; email: string; expires_at: Date; expired: boolean }>(
              `select id, email, expires_at, expires_at < now() as expired from invitations
               where client_id = $1 and accepted_at is null and revoked_at is null order by created_at desc`,
              [id],
            ),
          }
        : null;
    const runs =
      tab === "activity"
        ? await tx.q<{ id: string; created_at: Date; status: string; trigger: string; name: string; results: { type: string; detail: string; status: string }[]; error: string | null }>(
            `select r.id, r.created_at, r.status, r.trigger, ar.name, r.results, r.error from automation_runs r join automation_rules ar on ar.id = r.rule_id
             where r.client_id = $1 order by r.created_at desc limit 100`,
            [id],
          )
        : [];
    return { client, onboardings, current, staff, comments, emails, templates, latestVersion, plan, docCounts, timeline, documents, contacts, runs };
  });
  if (!data) notFound();
  const { client, current, staff } = data;
  const ai = aiStatus(auth.workspace);
  const email = emailConnection(auth.workspace);
  const isManager = auth.role === "admin" || auth.role === "manager";
  const base = `/app/clients/${client.id}${current && data.onboardings.length > 1 ? `?o=${current.id}&` : "?"}`;
  const open = !!current && (current.status === "active" || current.status === "paused");
  const value = client.deal_amount ? formatMoney(Number(client.deal_amount), client.deal_recurrence) : null;
  const valueLabel = current?.state.stage === "ready" ? "New Business Awaiting Kickoff" : "Contract Value in Active Onboarding";

  return (
    <>
      <div className="mb-3 text-sm">
        <Link href="/app/clients" className="text-ink-500 hover:text-ink-800">
          ← Clients
        </Link>
      </div>

      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{client.name}</h1>
            {current && <StageBadge stage={current.state.stage} />}
            {current &&
              !(current.state.waitingOn === "client" && current.state.stage === "waiting_client") &&
              !(current.state.waitingOn === "staff" && current.state.stage === "review") && <WaitingOnBadge waitingOn={current.state.waitingOn} />}
            {current?.at_risk && <AtRiskBadge />}
          </div>
          <p className="mt-1 text-sm text-ink-500">
            {[client.client_type_name ?? "No client type", client.industry, client.timezone].filter(Boolean).join(" · ")}
            {client.website && (
              <>
                {" · "}
                <a href={client.website} className="link" target="_blank" rel="noreferrer">
                  {client.website.replace(/^https?:\/\//, "")}
                </a>
              </>
            )}
          </p>
        </div>
        {open && current && (
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm action={setOnboardingStatusAction} showSuccess={false}>
              <input type="hidden" name="onboardingId" value={current.id} />
              <input type="hidden" name="status" value={current.status === "paused" ? "active" : "paused"} />
              <SubmitButton className="btn-secondary">
                {current.status === "paused" ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                {current.status === "paused" ? "Resume" : "Pause"}
              </SubmitButton>
            </ActionForm>
            {current.status === "active" && !current.kickoff_ready_at && auth.canApprove && (
              <ActionForm
                action={markReadyForKickoffAction}
                showSuccess={false}
                confirm={
                  current.state.readyForCompletion
                    ? "Mark this client Ready for Kickoff? Handoff automations will run."
                    : `${current.state.progress.requiredTotal - current.state.progress.requiredApproved} required item(s) are not approved yet. Mark Ready for Kickoff anyway? Handoff automations will run.`
                }
              >
                <input type="hidden" name="onboardingId" value={current.id} />
                <input type="hidden" name="ready" value="true" />
                <SubmitButton className="btn-secondary">
                  <Rocket className="h-4 w-4" /> Mark Ready for Kickoff
                </SubmitButton>
              </ActionForm>
            )}
            <AtRiskControl onboardingId={current.id} atRisk={current.at_risk} />
            <Link href={`${base}tab=contacts#invite`} className="btn-secondary">
              <UserPlus className="h-4 w-4" /> Invite
            </Link>
          </div>
        )}
      </div>

      <div className="card mb-6 grid grid-cols-2 gap-x-6 gap-y-4 p-5 md:grid-cols-3 xl:grid-cols-6">
        <Meta label="Client type">{client.client_type_name ?? <span className="text-ink-400">Not set</span>}</Meta>
        <Meta label="Primary contact">
          <span className="block truncate">{client.primary_contact_name ?? <span className="text-ink-400">Not set</span>}</span>
          {client.primary_contact_email && <span className="block truncate text-xs font-normal text-ink-500">{client.primary_contact_email}</span>}
        </Meta>
        <Meta label="Account manager">{client.owner_name ?? <span className="text-ink-400">Unassigned</span>}</Meta>
        <Meta label="Onboarding owner">{current?.owner_name ?? <span className="text-ink-400">Unassigned</span>}</Meta>
        <Meta label={current && current.status === "completed" ? "Contract value" : valueLabel}>{value ?? <span className="text-ink-400">Not recorded</span>}</Meta>
        <Meta label="Started">{current ? formatDate(current.start_date + "T12:00:00Z") : <span className="text-ink-400">Not started</span>}</Meta>
      </div>

      {!current ? (
        <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Start an onboarding">
          {data.templates.length === 0 ? (
            <EmptyState title="No published templates" description="Publish a template first, then start this client's onboarding from it." action={<Link href="/app/templates" className="btn-primary">Templates</Link>} />
          ) : (
            <ActionForm action={startOnboardingAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="clientId" value={client.id} />
              <div className="flex-1">
                <label className="label" htmlFor="templateId">Template</label>
                <select id="templateId" name="templateId" className="input">
                  {data.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} (v{t.current_version})
                    </option>
                  ))}
                </select>
              </div>
              <SubmitButton>Start onboarding</SubmitButton>
            </ActionForm>
          )}
        </Card>
        <Card title="Invite a client contact">
          <InviteContactForm clientId={client.id} defaultEmail={client.primary_contact_email ?? ""} />
          {auth.workspace.is_demo && <p className="mt-2 text-xs text-ink-500">Demo workspace: invitation emails are recorded, never sent.</p>}
        </Card>
        </div>
      ) : (
        <>
          {data.onboardings.length > 1 && (
            <div className="mb-4 flex flex-wrap gap-2 text-sm">
              {data.onboardings.map((o) => (
                <Link
                  key={o.id}
                  href={`/app/clients/${client.id}?o=${o.id}`}
                  className={clsx("rounded-full px-3 py-1 ring-1", o.id === current.id ? "bg-brand-50 font-medium text-brand-800 ring-brand-200" : "bg-white text-ink-600 ring-ink-200")}
                >
                  {o.name} · {o.status} · {formatDate(o.created_at)}
                </Link>
              ))}
            </div>
          )}

          <StatusNotices current={current} canApprove={auth.canApprove} />

          <ReadinessPanel current={current} clientId={client.id} names={staff.map} />

          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <div className="min-w-0 space-y-6 xl:col-span-2">
              <Tabs active={tab} tabs={TABS.map((t) => ({ key: t, label: TAB_LABEL[t], href: `${base}tab=${t}` }))} />

              {tab === "requirements" && (
                <RequirementsTab current={current} clientId={client.id} names={staff.map} staffList={staff.list} docCounts={data.docCounts} isManager={isManager} meId={auth.user.id} />
              )}

              {tab === "timeline" && (
                <Card title="Timeline" padded={false} action={<span className="text-xs text-ink-500">Complete audit trail for {client.name}</span>}>
                  <TimelineList entries={data.timeline} />
                </Card>
              )}

              {tab === "documents" && (
                <Card title="Documents" padded={false} action={<Link href={`/app/documents?client=${client.id}`} className="text-xs link">All documents</Link>}>
                  {data.documents.some((d) => d.scan_status === "not_scanned") && (
                    <p className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs font-medium text-amber-900">{SCAN_NOT_CONFIGURED}</p>
                  )}
                  {data.documents.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-ink-500">No files uploaded yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px]">
                        <thead className="border-b border-ink-100 bg-ink-50/60">
                          <tr>
                            <th className="table-head">File</th>
                            <th className="table-head">Status</th>
                            <th className="table-head">Uploaded</th>
                            <th className="table-head" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {data.documents.map((d) => (
                            <tr key={d.version_id} className="hover:bg-ink-50">
                              <td className="table-cell">
                                <Link href={`/app/clients/${client.id}/items/${d.item_id}`} className="font-medium text-ink-900 hover:text-brand-700">
                                  {d.title}
                                </Link>
                                <p className="text-xs text-ink-500">
                                  {d.item_title} · v{d.version}
                                  {d.versions > 1 && ` of ${d.versions}`} · {formatBytes(d.size_bytes)}
                                  {d.category && ` · ${d.category}`}
                                </p>
                              </td>
                              <td className="table-cell">
                                <div className="flex flex-wrap gap-1">
                                  <DocReviewBadge status={d.review_status} />
                                  <ScanBadge status={d.scan_status} />
                                  <ExpiryBadge expiresOn={d.expires_on} />
                                </div>
                              </td>
                              <td className="table-cell text-xs text-ink-500">
                                {d.uploader ?? "Unknown"}
                                <br />
                                {formatDateTime(d.created_at)}
                              </td>
                              <td className="table-cell text-right">
                                {d.purged_at ? (
                                  <span className="text-xs text-ink-400">Deleted (retention)</span>
                                ) : (
                                  <a href={`/api/files/link?v=${d.version_id}`} className="btn-secondary px-2.5 py-1 text-xs">
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
                </Card>
              )}

              {tab === "contacts" && data.contacts && (
                <div className="space-y-6">
                  <Card title="Contacts" padded={false}>
                    {data.contacts.people.length === 0 ? (
                      <p className="px-5 py-4 text-sm text-ink-500">No contacts recorded for {client.name}.</p>
                    ) : (
                      <ul className="divide-y divide-ink-100">
                        {data.contacts.people.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                            <Avatar name={p.name} />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-ink-900">
                                {p.name} {p.title && <span className="font-normal text-ink-500">· {p.title}</span>}
                              </p>
                              <p className="truncate text-xs text-ink-500">{[p.email, p.phone].filter(Boolean).join(" · ") || "No email or phone"}</p>
                            </div>
                            <Badge tone={p.contact_role === "primary" ? "brand" : "neutral"}>{CONTACT_ROLE[p.contact_role] ?? p.contact_role}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card title="Portal access">
                    {data.contacts.portal.length === 0 && data.contacts.invites.length === 0 && (
                      <p className="text-sm text-ink-500">No one from {client.name} has portal access yet.</p>
                    )}
                    <ul className="space-y-3">
                      {data.contacts.portal.map((c) => (
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
                      {data.contacts.invites.map((i) => (
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
                    <div id="invite" className="mt-4 border-t border-ink-100 pt-4">
                      <InviteContactForm clientId={client.id} defaultEmail={data.contacts.portal.length === 0 ? client.primary_contact_email ?? "" : ""} />
                      {auth.workspace.is_demo && <p className="mt-2 text-xs text-ink-500">Demo workspace: invitation emails are recorded, never sent.</p>}
                    </div>
                  </Card>
                </div>
              )}

              {tab === "activity" && (
                <Card title="Automation activity" padded={false} action={<Link href="/app/settings" className="text-xs link">Automation rules</Link>}>
                  {data.runs.length === 0 ? (
                    <p className="px-5 py-6 text-sm text-ink-500">No automations have run for {client.name} yet.</p>
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {data.runs.map((r) => (
                        <li key={r.id} className="px-5 py-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-ink-900">{r.name}</p>
                            <div className="flex items-center gap-2">
                              <Badge tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : r.status === "partial" ? "warning" : "neutral"}>{r.status}</Badge>
                              <span className="text-xs text-ink-400">{formatDateTime(r.created_at)}</span>
                            </div>
                          </div>
                          <p className="mt-0.5 text-xs text-ink-500">Trigger: {r.trigger.replace(/_/g, " ")}</p>
                          {r.results.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {r.results.map((x, i) => (
                                <li key={i} className="flex items-start gap-2 text-xs">
                                  <span className={clsx("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", x.status === "done" ? "bg-emerald-500" : x.status === "failed" ? "bg-rose-500" : "bg-ink-300")} />
                                  <span className="text-ink-700">
                                    {x.detail}
                                    {x.status !== "done" && <span className="text-ink-400"> ({x.status})</span>}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.error && <p className="mt-1 text-xs text-rose-700">{r.error}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
            </div>

            <div className="min-w-0 space-y-6">
              <Card title="Why it's blocked">
                <BlockerList blockers={current.state.blockers} names={staff.map} clientId={client.id} paused={current.status === "paused"} />
              </Card>

              <Card title="Assistant">
                <AiPanel onboardingId={current.id} aiAvailable={ai.available} aiReason={ai.reason} emailMode={email.mode} labels={ASSIST_LABEL} />
              </Card>

              <TemplateBox current={current} latestVersion={data.latestVersion} plan={data.plan} isManager={isManager} />

              <Card title="Messages and notes" padded={false}>
                <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2 border-b border-ink-100 p-4">
                  <input type="hidden" name="onboardingId" value={current.id} />
                  <textarea name="body" className="input min-h-[70px] text-sm" placeholder="Write a message to the client or an internal note" required />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <select name="visibility" className="input w-auto py-1.5 text-sm" aria-label="Visibility" defaultValue="internal">
                      <option value="internal">Internal note (team only)</option>
                      <option value="client">Message to client (visible in portal)</option>
                    </select>
                    <SubmitButton className="btn-primary px-3 py-1.5">Post</SubmitButton>
                  </div>
                </ActionForm>
                <div className="max-h-[460px] overflow-y-auto">
                  <CommentList comments={data.comments} />
                </div>
              </Card>

              <Card title="Reminders" padded={false}>
                <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3 text-sm">
                  <span>{current.reminders_enabled ? "Automatic reminders on" : "Automatic reminders off"}</span>
                  {open && (
                    <ActionForm action={toggleOnboardingRemindersAction} showSuccess={false}>
                      <input type="hidden" name="onboardingId" value={current.id} />
                      <input type="hidden" name="enabled" value={current.reminders_enabled ? "false" : "true"} />
                      <SubmitButton className="btn-secondary px-3 py-1 text-xs">{current.reminders_enabled ? "Turn off" : "Turn on"}</SubmitButton>
                    </ActionForm>
                  )}
                </div>
                {auth.workspace.is_demo && <p className="border-b border-ink-100 px-4 py-2 text-xs text-ink-500">Demo workspace: reminders are recorded in the outbox, never sent.</p>}
                {data.emails.length === 0 ? (
                  <p className="p-4 text-sm text-ink-500">
                    No emails yet.{" "}
                    <Link href="/app/settings/reminders" className="link">
                      Reminder rules
                    </Link>
                  </p>
                ) : (
                  <ul className="divide-y divide-ink-100">
                    {data.emails.map((e) => (
                      <li key={e.id} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate">{e.subject}</span>
                          <Badge tone={e.status === "sent" ? "success" : e.status === "failed" ? "danger" : e.status === "simulated" ? "brand" : "neutral"}>
                            {e.status === "simulated" ? "demo" : e.status}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-ink-500">
                          {e.to_email} · {formatDateTime(e.created_at)}
                          {(e.error ?? e.status_reason) && ` · ${e.error ?? e.status_reason}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function AtRiskControl({ onboardingId, atRisk }: { onboardingId: string; atRisk: boolean }) {
  if (atRisk)
    return (
      <ActionForm action={setAtRiskAction} showSuccess={false}>
        <input type="hidden" name="onboardingId" value={onboardingId} />
        <input type="hidden" name="atRisk" value="false" />
        <SubmitButton className="btn-secondary">
          <Flag className="h-4 w-4" /> Clear At Risk
        </SubmitButton>
      </ActionForm>
    );
  return (
    <details className="group relative">
      <summary className="btn-secondary cursor-pointer list-none">
        <Flag className="h-4 w-4" /> Flag At Risk
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-ink-200 bg-white p-4 shadow-lg">
        <ActionForm action={setAtRiskAction} className="space-y-2">
          <input type="hidden" name="onboardingId" value={onboardingId} />
          <input type="hidden" name="atRisk" value="true" />
          <label className="label" htmlFor="at-risk-reason">Why is this client at risk?</label>
          <textarea id="at-risk-reason" name="reason" className="input min-h-[80px] text-sm" placeholder="e.g. Client unresponsive for two weeks; kickoff date at risk" required />
          <SubmitButton className="btn-danger w-full">Flag At Risk</SubmitButton>
        </ActionForm>
      </div>
    </details>
  );
}

function StatusNotices({ current, canApprove }: { current: LoadedOnboarding; canApprove: boolean }) {
  return (
    <div className="space-y-3 empty:hidden [&>*:last-child]:mb-6">
      {current.at_risk && (
        <Notice tone="danger" title="At Risk">
          {current.at_risk_reason ?? "Flagged without a reason."}
        </Notice>
      )}
      {current.status === "paused" && (
        <Notice tone="warning" title="Onboarding paused">
          Paused {current.paused_at ? formatDate(current.paused_at) : ""}. No reminders or automations run while paused. The client can still see their checklist.
        </Notice>
      )}
      {current.status === "completed" && (
        <Notice tone="success" title="Onboarding complete">
          Approved on {formatDate(current.completed_at)}. All required items were accepted.
        </Notice>
      )}
      {current.status === "cancelled" && <Notice title="Onboarding cancelled">This onboarding was cancelled. Its history is kept below.</Notice>}
      {current.state.readyForCompletion && current.status === "active" && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-brand-900">All required items are approved</p>
              <p className="text-sm text-brand-900/80">An authorized team member can approve completion to close this onboarding.</p>
            </div>
            {canApprove ? (
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
    </div>
  );
}

function ReadinessPanel({ current, clientId, names }: { current: LoadedOnboarding; clientId: string; names: Map<string, string> }) {
  const { readiness, blockers, waitingOn, blockedDays, blockedSince } = current.state;
  const tone = readinessTone(readiness.score);
  const kickoff = current.kickoff;
  const itemHref = (itemId: string) => `/app/clients/${clientId}/items/${itemId}`;
  const ready = readiness.ready;
  const closed = current.status === "completed" || current.status === "cancelled";
  return (
    <section className="card overflow-hidden">
      <div className="grid gap-0 lg:grid-cols-[260px_1fr]">
        <div className={clsx("flex flex-col items-center justify-center gap-3 border-b border-ink-100 p-6 lg:border-b-0 lg:border-r", tone.bg)}>
          <ReadinessRing score={readiness.score} size={120} label={false} />
          <div className="text-center">
            <p className={clsx("text-3xl font-semibold tracking-tight tabular-nums", tone.text)}>{readiness.score == null ? "–" : `${readiness.score}% Ready`}</p>
            <p className="mt-1 text-xs text-ink-500">
              {current.state.progress.requiredApproved} of {current.state.progress.requiredTotal} required approved
            </p>
          </div>
        </div>
        <div className="grid min-w-0 gap-6 p-6 md:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Ready</p>
            {ready.length === 0 ? (
              <p className="mt-2 text-sm text-ink-400">Nothing approved yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {ready.slice(0, 7).map((l) => (
                  <li key={l.itemId} className="flex items-start gap-2 text-sm">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <Link href={itemHref(l.itemId)} className="min-w-0 truncate text-ink-700 hover:text-brand-700">{l.title}</Link>
                  </li>
                ))}
                {ready.length > 7 && <li className="pl-6 text-xs text-ink-500">+{ready.length - 7} more approved</li>}
              </ul>
            )}
            {readiness.partial.length > 0 && (
              <>
                <p className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-amber-700">In review (half credit)</p>
                <ul className="mt-2 space-y-1.5">
                  {readiness.partial.slice(0, 5).map((l) => (
                    <li key={l.itemId} className="flex items-start gap-2 text-sm">
                      <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <Link href={itemHref(l.itemId)} className="min-w-0 truncate text-ink-700 hover:text-brand-700">{l.title}</Link>
                    </li>
                  ))}
                  {readiness.partial.length > 5 && <li className="pl-6 text-xs text-ink-500">+{readiness.partial.length - 5} more</li>}
                </ul>
              </>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-700">Blocked</p>
            {blockers.length === 0 ? (
              <p className="mt-2 text-sm text-ink-400">No blockers.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {blockers.slice(0, 6).map((b) => (
                  <li key={b.itemId} className="text-sm">
                    <Link href={itemHref(b.itemId)} className="flex items-start gap-2 text-ink-800 hover:text-brand-700">
                      <AlertTriangle className={clsx("mt-0.5 h-4 w-4 shrink-0", b.critical ? "text-rose-600" : "text-amber-500")} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{b.title}</span>
                        <span className="block text-xs text-ink-500">{b.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
                {blockers.length > 6 && <li className="pl-6 text-xs text-ink-500">+{blockers.length - 6} more below</li>}
              </ul>
            )}
          </div>
          <div className="min-w-0 space-y-5">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Waiting on</p>
              <p className="mt-1 text-lg font-semibold text-ink-900">
                {current.status === "paused" ? "Paused" : closed ? "Nothing" : waitingOn ? WAITING_TEXT[waitingOn] : "Nothing"}
              </p>
              {waitingOn && <WaitingBreakdown blockers={blockers} names={names} />}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Blocked for</p>
              <p className="mt-1 text-lg font-semibold text-ink-900">{blockedSince ? `${blockedDays} day${blockedDays === 1 ? "" : "s"}` : "Not blocked"}</p>
              {blockedSince && <p className="text-xs text-ink-500">since {formatDate(blockedSince)}</p>}
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Projected kickoff</p>
            {kickoff.date ? (
              <>
                <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-ink-900">
                  <CalendarDays className="h-4 w-4 text-ink-400" /> {formatDate(kickoff.date)}
                </p>
                <Badge tone={kickoff.basis === "scheduled" ? "success" : "neutral"} className="mt-1">
                  {kickoff.basis === "scheduled" ? "Scheduled" : "Estimate"}
                </Badge>
              </>
            ) : (
              <p className="mt-1 text-sm text-ink-500">{closed ? "Not applicable" : "Not enough data yet."}</p>
            )}
            {kickoff.note && <p className="mt-1.5 text-xs text-ink-500">{kickoff.note}</p>}
            {current.kickoff_ready_at && <p className="mt-1.5 text-xs font-medium text-brand-700">Ready for Kickoff since {formatDate(current.kickoff_ready_at)}</p>}
            {!closed && (
              <ActionForm action={setKickoffDateAction} className="mt-3" showSuccess={false}>
                <input type="hidden" name="onboardingId" value={current.id} />
                <label className="sr-only" htmlFor="kickoffDate">Kickoff date</label>
                <div className="flex gap-1.5">
                  <input id="kickoffDate" type="date" name="kickoffDate" className="input min-w-0 py-1 text-sm" defaultValue={current.kickoff_date ?? ""} />
                  <SubmitButton className="btn-secondary shrink-0 px-2.5 py-1 text-xs">{current.kickoff_date ? "Update" : "Set"}</SubmitButton>
                </div>
              </ActionForm>
            )}
          </div>
        </div>
      </div>
      <details className="group border-t border-ink-100">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-3 text-sm font-medium text-ink-600 hover:text-ink-900">
          <Info className="h-4 w-4" /> How this score is calculated
          <ChevronRight className="ml-auto h-4 w-4 transition group-open:rotate-90" />
        </summary>
        <ul className="list-disc space-y-1 px-6 pb-4 pl-11 text-sm text-ink-600">
          {readiness.explanation.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function WaitingBreakdown({ blockers, names }: { blockers: Blocker[]; names: Map<string, string> }) {
  const counts = { client: 0, staff: 0, integration: 0 };
  for (const b of blockers) counts[b.waitingOn]++;
  const staffOwners = [...new Set(blockers.filter((b) => b.waitingOn === "staff" && b.ownerUserId).map((b) => names.get(b.ownerUserId!) ?? "a former member"))];
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-ink-500">
      {counts.client > 0 && <li>Client: {counts.client} item{counts.client === 1 ? "" : "s"}</li>}
      {counts.staff > 0 && (
        <li>
          Staff: {counts.staff} item{counts.staff === 1 ? "" : "s"}
          {staffOwners.length > 0 && ` (${staffOwners.join(", ")})`}
        </li>
      )}
      {counts.integration > 0 && <li>Integration: {counts.integration}</li>}
    </ul>
  );
}

function BlockerList({ blockers, names, clientId, paused }: { blockers: Blocker[]; names: Map<string, string>; clientId: string; paused: boolean }) {
  if (blockers.length === 0)
    return <p className="text-sm text-ink-600">{paused ? "The onboarding is paused." : "Nothing is blocking this onboarding right now."}</p>;
  const summary = explainBlockers(blockers, names);
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-sm text-ink-700">
        {summary.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
        {blockers.map((b) => (
          <li key={b.itemId}>
            <Link href={`/app/clients/${clientId}/items/${b.itemId}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-ink-50">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">
                  {b.title} {b.critical && <span className="text-xs font-semibold text-rose-600">Critical</span>}
                </p>
                <p className="truncate text-xs text-ink-500">
                  {BLOCKER_LABEL[b.category]} · {b.detail}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-300" />
            </Link>
          </li>
        ))}
      </ul>
      {paused && <p className="text-xs text-ink-500">The onboarding is paused.</p>}
    </div>
  );
}

function TemplateBox({ current, latestVersion, plan, isManager }: { current: LoadedOnboarding; latestVersion: number | null; plan: UpgradePlan | null; isManager: boolean }) {
  if (!current.template_name) return null;
  const newer = latestVersion && current.template_version && latestVersion > current.template_version;
  return (
    <Card title="Template version">
      <p className="text-sm text-ink-700">
        Using <span className="font-medium text-ink-900">{current.template_name} v{current.template_version ?? "?"}</span>
      </p>
      {!newer ? (
        <p className="mt-1 text-xs text-ink-500">This is the latest published version.</p>
      ) : !plan ? (
        <p className="mt-1 text-xs text-ink-500">Version {latestVersion} is published. Upgrades are available for active or paused onboardings.</p>
      ) : (
        <div className="mt-3">
          <Badge tone="brand">v{plan.toVersion} available</Badge>
          <details className="group mt-3">
            <summary className="btn-secondary cursor-pointer list-none px-3 py-1.5 text-xs">Preview upgrade</summary>
            <div className="mt-3 space-y-3 text-sm">
              <PlanList title="Added" tone="text-emerald-700" items={plan.added.map((a) => `${a.title} (${a.section})`)} />
              <PlanList title="Updated" tone="text-sky-700" items={plan.updated.map((u) => `${u.title}: ${u.changes.join(", ")}`)} />
              <PlanList title="Kept because started" tone="text-amber-700" items={[...plan.keptStarted, ...plan.keptRemoved].map((k) => `${k.title}: ${k.reason}`)} />
              <PlanList title="Removed" tone="text-rose-700" items={plan.removed.map((r) => r.title)} />
              {isManager && current.status !== "completed" ? (
                <ActionForm action={applyTemplateUpgradeAction} className="space-y-2 border-t border-ink-100 pt-3">
                  <input type="hidden" name="onboardingId" value={current.id} />
                  <input type="hidden" name="toVersion" value={plan.toVersion} />
                  <label className="flex items-start gap-2 text-xs text-ink-600">
                    <input type="checkbox" name="confirm" className="mt-0.5 h-4 w-4 rounded" required />
                    I reviewed these changes. Items already started keep their current version and nothing the client submitted is lost.
                  </label>
                  <SubmitButton className="btn-primary w-full" pendingText="Applying…">
                    Apply upgrade to v{plan.toVersion}
                  </SubmitButton>
                </ActionForm>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-ink-500">
                  <Lock className="h-3.5 w-3.5" /> Only managers can apply template upgrades.
                </p>
              )}
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}

function PlanList({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <p className={clsx("text-[11px] font-semibold uppercase tracking-wider", tone)}>
        {title} ({items.length})
      </p>
      {items.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-700">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RequirementsTab({
  current,
  clientId,
  names,
  staffList,
  docCounts,
  isManager,
  meId,
}: {
  current: LoadedOnboarding;
  clientId: string;
  names: Map<string, string>;
  staffList: { id: string; name: string }[];
  docCounts: Map<string, number>;
  isManager: boolean;
  meId: string;
}) {
  const live = current.items.filter((i) => !i.removed_at);
  const removed = current.items.filter((i) => i.removed_at);
  const byKey = new Map<string, ItemLike>(live.map((i) => [i.item_key, i]));
  const sections = new Map<string, typeof live>();
  for (const item of live) sections.set(item.section_title, [...(sections.get(item.section_title) ?? []), item]);
  const open = current.status === "active" || current.status === "paused";

  return (
    <div className="space-y-6">
      {live.length === 0 && <EmptyState title="No requirements" description="This onboarding has no live requirements." />}
      {[...sections.entries()].map(([section, items]) => {
        const approved = items.filter((i) => i.status === "approved").length;
        return (
          <Card key={section} title={section} padded={false} action={<span className="text-xs text-ink-500">{approved}/{items.length} done</span>}>
            <ul className="divide-y divide-ink-100">
              {items.map((item) => {
                const status = displayStatus(item, byKey);
                const deps = unmetDependencies(item, byKey);
                const overdue = isOverdue(item) && item.required;
                const reviewer = item.reviewer_user_id ? names.get(item.reviewer_user_id) : null;
                const owner = item.owner_user_id ? names.get(item.owner_user_id) : null;
                const docs = docCounts.get(item.id) ?? 0;
                return (
                  <li key={item.id}>
                    <Link href={`/app/clients/${clientId}/items/${item.id}`} className="flex flex-col gap-2 px-5 py-3.5 hover:bg-ink-50 sm:flex-row sm:items-center sm:gap-4">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <KindIcon kind={item.kind} />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-ink-900">
                            <span className="min-w-0">{item.title}</span>
                            {item.critical && <Badge tone="danger">Critical</Badge>}
                            {(item.weight ?? 1) > 1 && <span className="text-xs font-normal text-ink-400" title="Readiness weight">×{item.weight}</span>}
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
                            <span>{KIND_LABEL[item.kind as keyof typeof KIND_LABEL] ?? item.kind}</span>
                            <span>· {item.required ? "Required" : "Optional"}</span>
                            {item.audience === "internal" && <Badge tone="brand">Internal</Badge>}
                            {item.category && SENSITIVE_CATEGORIES.has(item.category) && <Badge tone="warning">Human review</Badge>}
                            {docs > 0 && <span>· {docs} file{docs === 1 ? "" : "s"}</span>}
                            {item.kind !== "task" && reviewer && <span>· Reviewer: {reviewer}</span>}
                            {item.kind === "task" && owner && <span>· Owner: {owner}</span>}
                          </p>
                          {status === "blocked" && <p className="mt-1 text-xs font-medium text-amber-700">Waiting on {deps.map((d) => `"${d.title}"`).join(", ")}</p>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 pl-9 sm:pl-0">
                        {item.due_at && item.status !== "approved" && (
                          <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap text-xs", overdue ? "font-medium text-rose-700" : "text-ink-500")}>
                            <Clock className="h-3 w-3" />
                            {overdue ? "Overdue · " : "Due "}
                            {formatDate(item.due_at)}
                          </span>
                        )}
                        <StatusBadge status={status} task={item.kind === "task"} />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}

      {removed.length > 0 && (
        <details className="card group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium text-ink-600">
            Removed requirements ({removed.length})
            <ChevronRight className="ml-auto h-4 w-4 transition group-open:rotate-90" />
          </summary>
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {removed.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="min-w-0">
                  <Link href={`/app/clients/${clientId}/items/${i.id}`} className="text-ink-600 line-through hover:text-ink-900">
                    {i.title}
                  </Link>
                  <span className="ml-2 text-xs text-ink-400">removed {formatDate(i.removed_at)}</span>
                </span>
                {isManager && open && (
                  <ActionForm action={restoreRequirementAction} showSuccess={false}>
                    <input type="hidden" name="itemId" value={i.id} />
                    <SubmitButton className="btn-ghost px-2 py-1 text-xs">Restore</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {open && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Ask the client a question">
            <ActionForm action={addQuestionAction} resetOnSuccess className="space-y-3">
              <input type="hidden" name="onboardingId" value={current.id} />
              <textarea name="question" className="input min-h-[80px]" placeholder="e.g. Which location should we focus on first?" required />
              <div className="flex flex-wrap items-center gap-3">
                <input type="date" name="dueDate" className="input w-auto" aria-label="Due date" />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded" /> Required
                </label>
              </div>
              <SubmitButton pendingText="Adding…">Add to client checklist</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Add an internal task">
            <ActionForm action={addTaskAction} resetOnSuccess className="space-y-3">
              <input type="hidden" name="onboardingId" value={current.id} />
              <input name="title" className="input" placeholder="Task title" required />
              <div className="grid grid-cols-2 gap-3">
                <select name="ownerId" className="input" defaultValue={meId} aria-label="Owner">
                  <option value="">Unassigned</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input type="date" name="dueDate" className="input" aria-label="Due date" />
              </div>
              <details>
                <summary className="cursor-pointer text-sm text-ink-600">Depends on…</summary>
                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {live.map((i) => (
                    <label key={i.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="dependsOn" value={i.item_key} className="h-4 w-4 rounded" /> {i.title}
                    </label>
                  ))}
                </div>
              </details>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="required" defaultChecked className="h-4 w-4 rounded" /> Required for completion
              </label>
              <SubmitButton pendingText="Adding…">Add task</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
    </div>
  );
}
