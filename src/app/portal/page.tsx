import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, CalendarClock, CheckCircle2, ChevronRight, Clock, Lock, Mail, MessageCircleQuestion, Phone } from "lucide-react";
import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { systemCtx } from "@/lib/automation/engine";
import { computeOnboardingState, computeReadiness, displayStatus, isAwaitingReview, isOverdue, nextClientActions, unmetDependencies, type ItemLike, type ItemStatus } from "@/lib/onboarding";
import { Avatar, Notice, Progress, ReadinessRing, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate, formatDateTime, relativeDays } from "@/lib/time";
import { clientCommentAction } from "./actions";
import { portalBrand } from "./brand";

export const metadata = { title: "Your onboarding" };

type PortalItem = ItemLike & { description: string | null; position: number; kind: string };
type Comment = { id: string; body: string; created_at: Date; item_id: string | null; author: string | null; from_team: boolean; mine: boolean; item_title: string | null };

const OPEN: ItemStatus[] = ["not_started", "in_progress", "changes_requested"];

export default async function PortalHome() {
  const auth = await requireClient();
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    // RLS limits a client to their own client record, client-facing items and client-visible comments.
    // The filters below repeat those rules so this page never depends on policy alone.
    const onboarding = await tx.one<{
      id: string; name: string; status: "active" | "paused" | "completed" | "cancelled"; owner_user_id: string | null;
      kickoff_ready_at: Date | null; kickoff_date: Date | null; completed_at: Date | null;
    }>(
      `select id, name, status, owner_user_id, kickoff_ready_at, kickoff_date, completed_at from onboardings
       where client_id = $1 and status <> 'cancelled'
       order by (status = 'active') desc, created_at desc limit 1`,
      [auth.clientId],
    );
    const client = await tx.one<{ timezone: string; owner_user_id: string | null }>("select timezone, owner_user_id from clients where id = $1", [auth.clientId]);
    if (!onboarding) return { onboarding: null, tz: client?.timezone ?? auth.workspace.timezone } as const;
    const items = await tx.q<PortalItem>(
      `select id, item_key, title, description, kind, audience, required, status, due_at, owner_user_id, depends_on, section_title, position,
              submitted_at, updated_at, status_changed_at, reviewed_at, weight, critical, removed_at, category
       from onboarding_items where onboarding_id = $1 and client_id = $2 and audience = 'client' and removed_at is null order by position`,
      [onboarding.id, auth.clientId],
    );
    const comments = await tx.q<Comment>(
      `select c.id, c.body, c.created_at, c.item_id, u.name as author, i.title as item_title,
              c.author_user_id = $2 as mine,
              (c.author_user_id is null or not exists (select 1 from memberships m where m.user_id = c.author_user_id and m.role = 'client')) as from_team
       from comments c left join users u on u.id = c.author_user_id left join onboarding_items i on i.id = c.item_id
       where c.onboarding_id = $1 and c.visibility = 'client' and c.client_id = $3
       order by c.created_at desc limit 40`,
      [onboarding.id, auth.user.id, auth.clientId],
    );
    const managerId = onboarding.owner_user_id ?? client?.owner_user_id ?? null;
    const manager = managerId ? await tx.one<{ name: string; email: string }>("select name, email from users where id = $1", [managerId]) : null;
    return { onboarding, items, comments, manager, tz: client?.timezone ?? auth.workspace.timezone } as const;
  });

  const ws = auth.workspace;
  const brand = portalBrand(ws);
  const firstName = auth.user.name.split(" ")[0];

  if (!data.onboarding) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-xl font-semibold">Nothing to do yet</h1>
        <p className="mt-2 text-ink-600">{brand.company} hasn't started your onboarding checklist yet. We'll let you know as soon as it's ready.</p>
      </div>
    );
  }

  const { onboarding, items, comments, manager, tz } = data;
  const now = new Date();
  const byKey = new Map<string, ItemLike>(items.map((i) => [i.item_key, i]));
  const state = computeOnboardingState(onboarding, items, now);
  const closed = onboarding.status === "completed";
  const isBlocked = (i: ItemLike) => unmetDependencies(i, byKey).length > 0;

  // What still needs the client, before kickoff: changes requested first, then overdue, then by due date.
  const needsYou = items
    .filter((i) => i.required && OPEN.includes(i.status))
    .sort((a, b) => rank(a) - rank(b) || dueTime(a) - dueTime(b));
  function rank(i: ItemLike) {
    if (i.status === "changes_requested") return 0;
    if (isBlocked(i)) return 3;
    return isOverdue(i, now) ? 1 : 2;
  }
  const awaiting = items.filter((i) => isAwaitingReview(i.status));
  const next = nextClientActions(items, now);
  const primary = closed ? undefined : next.find((i) => !isBlocked(i));
  const deadlines = items
    .filter((i) => i.required && OPEN.includes(i.status) && i.due_at && new Date(i.due_at).getTime() - now.getTime() < 14 * 86400000)
    .sort((a, b) => dueTime(a) - dueTime(b))
    .slice(0, 6);
  const recentlySubmitted = items
    .filter((i) => i.submitted_at && i.status !== "approved")
    .sort((a, b) => new Date(b.submitted_at!).getTime() - new Date(a.submitted_at!).getTime())
    .slice(0, 6);
  const completed = items.filter((i) => i.status === "approved");

  // Questions from the team: open question items, plus team messages the client hasn't replied to yet.
  const openQuestions = items.filter((i) => i.kind === "question" && OPEN.includes(i.status) && !isBlocked(i));
  const unanswered = comments.filter(
    (c) => c.from_team && !comments.some((r) => !r.from_team && r.item_id === c.item_id && new Date(r.created_at) > new Date(c.created_at)),
  );
  const unansweredLatest = [...new Map(unanswered.map((c) => [c.item_id ?? "general", c])).values()].slice(0, 5);

  const reqTotal = state.progress.requiredTotal;
  const reqDone = state.progress.requiredApproved;
  // The readiness score is the same one staff see, so it also counts the agency's internal steps. Only the
  // number is read with system rights, for this client's own onboarding; internal items are never sent to the page.
  const overall = await withTenant(systemCtx(auth.workspace.id), async (tx) => {
    const all = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1 and client_id = $2", [onboarding.id, auth.clientId]);
    return computeReadiness(all, now);
  });
  const score = overall.score;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium" style={{ color: "var(--brand)" }}>{onboarding.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">Hi {firstName}</h1>
        {ws.portal_welcome && <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-ink-600">{ws.portal_welcome}</p>}
      </div>

      {onboarding.status === "paused" && (
        <Notice tone="warning" title="Onboarding paused">{brand.company} has paused this onboarding for now. You can still view and update your items.</Notice>
      )}

      {/* The one thing to do next */}
      <section className="card overflow-hidden">
        {closed ? (
          <div className="p-5 sm:p-6">
            <p className="flex items-center gap-2 text-lg font-semibold text-emerald-700"><CheckCircle2 className="h-5 w-5" /> You're all set</p>
            <p className="mt-1 text-sm text-ink-600">Everything is approved and onboarding is complete. Thank you!</p>
          </div>
        ) : primary ? (
          <div className="p-5 sm:p-6">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{primary.status === "changes_requested" ? "Needs your attention" : "Your next step"}</p>
            <p className="mt-1 text-xl font-semibold text-ink-900">{primary.title}</p>
            <p className={clsx("mt-1 text-sm", isOverdue(primary, now) ? "font-medium text-rose-700" : "text-ink-500")}>
              {primary.status === "changes_requested"
                ? "The team asked for a few changes."
                : primary.due_at
                  ? `${isOverdue(primary, now) ? "Was due" : "Due"} ${formatDate(primary.due_at, tz)} (${relativeDays(primary.due_at, now)})`
                  : primary.section_title}
            </p>
            <Link
              href={`/portal/items/${primary.id}`}
              className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg px-5 text-[15px] font-semibold text-white shadow-sm transition hover:opacity-95 sm:w-auto sm:inline-flex"
              style={{ background: "var(--brand)" }}
            >
              {primary.status === "changes_requested" ? "Review and resubmit" : primary.status === "in_progress" ? "Continue" : "Start"} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        ) : (
          <div className="p-5 sm:p-6">
            <p className="flex items-center gap-2 text-lg font-semibold text-ink-900"><Clock className="h-5 w-5 text-ink-400" /> Nothing needed from you right now</p>
            <p className="mt-1 text-sm text-ink-600">
              {awaiting.length > 0
                ? "We're reviewing your submissions. We'll let you know if anything else is needed."
                : onboarding.kickoff_date
                  ? `Kickoff is scheduled for ${formatDate(onboarding.kickoff_date)}.`
                  : "Your team is preparing for kickoff."}
            </p>
          </div>
        )}
        <div className="flex items-center gap-4 border-t border-ink-100 bg-ink-50/60 px-5 py-4 sm:px-6">
          <ReadinessRing score={score} size={60} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-ink-800">{reqTotal ? `${reqDone} of your ${reqTotal} required items approved` : "No required items"}</span>
              <span className="tabular-nums text-ink-500">{state.progress.percent}%</span>
            </div>
            <Progress value={state.progress.percent} className="mt-2" color="var(--brand)" />
            <details className="mt-2 text-xs text-ink-500">
              <summary className="cursor-pointer select-none">Readiness {score == null ? "not available yet" : `${score}%`} · how is this calculated?</summary>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                <li>Readiness counts every required step before kickoff, including your team's internal checks.</li>
                <li>Approved items count fully; items you've submitted count half until they're reviewed.</li>
                <li>Optional items never hold you back.</li>
              </ul>
            </details>
          </div>
        </div>
      </section>

      {/* What's blocking kickoff */}
      {!closed && (
        <section className="card">
          <div className="border-b border-ink-100 px-5 py-3.5">
            <h2 className="text-[15px] font-semibold text-ink-900">What's blocking kickoff</h2>
          </div>
          {needsYou.length > 0 ? (
            <>
              <ul className="divide-y divide-ink-100">
                {needsYou.map((i) => <ItemRow key={i.id} item={i} byKey={byKey} tz={tz} now={now} />)}
              </ul>
              <p className="border-t border-ink-100 px-5 py-3 text-sm text-ink-600">
                Once {needsYou.length === 1 ? "this is" : "these are"} completed, your team can move forward with kickoff.
                {awaiting.length > 0 && ` ${awaiting.length} item${awaiting.length === 1 ? " is" : "s are"} already with us for review.`}
              </p>
            </>
          ) : awaiting.length > 0 ? (
            <p className="px-5 py-4 text-sm text-ink-600">Nothing needed from you right now — we're reviewing your submissions.</p>
          ) : (
            <p className="px-5 py-4 text-sm text-ink-600">Nothing on your side is blocking kickoff. Thank you!</p>
          )}
        </section>
      )}

      {!closed && next.length > 0 && (
        <Section title="Next up" count={next.length}>
          {next.slice(0, 6).map((i) => <ItemRow key={i.id} item={i} byKey={byKey} tz={tz} now={now} />)}
        </Section>
      )}

      {!closed && deadlines.length > 0 && (
        <Section title="Upcoming deadlines" icon={<CalendarClock className="h-4 w-4 text-ink-400" />}>
          {deadlines.map((i) => (
            <li key={i.id}>
              <Link href={`/portal/items/${i.id}`} className="flex min-h-[56px] items-center gap-3 px-5 py-3 hover:bg-ink-50 active:bg-ink-100">
                <span className={clsx("w-16 shrink-0 text-xs font-semibold tabular-nums", isOverdue(i, now) ? "text-rose-700" : "text-ink-600")}>
                  {formatDate(i.due_at, tz).replace(/, \d{4}$/, "")}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{i.title}</span>
                <span className={clsx("shrink-0 text-xs", isOverdue(i, now) ? "font-medium text-rose-700" : "text-ink-500")}>
                  {isOverdue(i, now) ? "Overdue" : relativeDays(i.due_at, now)}
                </span>
              </Link>
            </li>
          ))}
        </Section>
      )}

      {(openQuestions.length > 0 || unansweredLatest.length > 0) && (
        <Section title="Questions from your team" icon={<MessageCircleQuestion className="h-4 w-4 text-ink-400" />}>
          {openQuestions.map((i) => <ItemRow key={i.id} item={i} byKey={byKey} tz={tz} now={now} />)}
          {unansweredLatest.map((c) => (
            <li key={c.id}>
              <Link href={c.item_id ? `/portal/items/${c.item_id}#comments` : "#messages"} className="block min-h-[56px] px-5 py-3 hover:bg-ink-50 active:bg-ink-100">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-700">{c.author ?? brand.company}{c.item_title ? ` · ${c.item_title}` : ""}</span>
                  <span className="shrink-0 text-ink-400">{formatDateTime(c.created_at, tz)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-800">{c.body}</p>
                <p className="mt-1 text-xs font-medium" style={{ color: "var(--brand)" }}>Reply →</p>
              </Link>
            </li>
          ))}
        </Section>
      )}

      {recentlySubmitted.length > 0 && (
        <Section title="Recently submitted">
          {recentlySubmitted.map((i) => (
            <ItemRow key={i.id} item={i} byKey={byKey} tz={tz} now={now} sub={`Submitted ${formatDate(i.submitted_at, tz)} · ${i.status === "changes_requested" ? "changes requested" : "with the team"}`} />
          ))}
        </Section>
      )}

      {completed.length > 0 && (
        <details className="card group" open={closed}>
          <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between px-5 py-3.5">
            <span className="text-[15px] font-semibold text-ink-900">Completed <span className="ml-1 text-sm font-normal text-ink-400">{completed.length}</span></span>
            <ChevronRight className="h-4 w-4 text-ink-400 transition group-open:rotate-90" />
          </summary>
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {completed.map((i) => <ItemRow key={i.id} item={i} byKey={byKey} tz={tz} now={now} sub={i.reviewed_at ? `Approved ${formatDate(i.reviewed_at, tz)}` : "Approved"} />)}
          </ul>
        </details>
      )}

      {manager && (
        <section className="card flex items-center gap-4 p-5">
          <Avatar name={manager.name} size="md" color="var(--brand)" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Your account manager</p>
            <p className="truncate font-semibold text-ink-900">{manager.name}</p>
            <a href={`mailto:${manager.email}`} className="inline-flex max-w-full items-center gap-1 truncate text-sm text-ink-600 hover:underline">
              <Mail className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{manager.email}</span>
            </a>
          </div>
          {ws.support_phone && (
            <a href={`tel:${ws.support_phone.replace(/[^\d+]/g, "")}`} className="btn-secondary h-11 w-11 shrink-0 p-0" aria-label={`Call ${brand.company}`}>
              <Phone className="h-4 w-4" />
            </a>
          )}
        </section>
      )}

      <section id="messages" className="card scroll-mt-20">
        <div className="border-b border-ink-100 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink-900">Messages with {brand.company}</h2>
        </div>
        {!closed && (
          <ActionForm action={clientCommentAction} resetOnSuccess className="space-y-2 border-b border-ink-100 p-4">
            <input type="hidden" name="onboardingId" value={onboarding.id} />
            <textarea name="body" className="input min-h-[88px] text-[15px]" placeholder="Ask a question or share an update" required maxLength={5000} />
            <SubmitButton className="btn-secondary min-h-[44px] w-full sm:w-auto" pendingText="Sending…">Send message</SubmitButton>
          </ActionForm>
        )}
        {comments.length === 0 ? (
          <p className="p-5 text-sm text-ink-500">No messages yet.</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {comments.slice(0, 15).map((c) => (
              <li key={c.id} className="px-5 py-3">
                <div className="flex justify-between gap-2 text-xs">
                  <span className="font-medium text-ink-700">{c.mine ? "You" : c.author ?? brand.company}</span>
                  <span className="shrink-0 text-ink-400">{formatDateTime(c.created_at, tz)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line break-words text-sm text-ink-700">{c.body}</p>
                {c.item_title && c.item_id && (
                  <Link href={`/portal/items/${c.item_id}`} className="mt-1 inline-block text-xs text-ink-400 hover:underline">On “{c.item_title}”</Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {primary && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white/95 p-3 backdrop-blur sm:hidden">
          <Link
            href={`/portal/items/${primary.id}`}
            className="flex min-h-[48px] w-full items-center justify-between gap-2 rounded-lg px-4 text-[15px] font-semibold text-white"
            style={{ background: "var(--brand)" }}
          >
            <span className="truncate">{primary.status === "changes_requested" ? "Fix" : "Next"}: {primary.title}</span>
            <ArrowRight className="h-4 w-4 shrink-0" />
          </Link>
        </div>
      )}
    </div>
  );
}

function dueTime(i: ItemLike) {
  return i.due_at ? new Date(i.due_at).getTime() : Infinity;
}

function Section({ title, count, icon, children }: { title: string; count?: number; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="flex items-center gap-2 border-b border-ink-100 px-5 py-3.5">
        {icon}
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        {count != null && <span className="text-sm text-ink-400">{count}</span>}
      </div>
      <ul className="divide-y divide-ink-100">{children}</ul>
    </section>
  );
}

function ItemRow({ item, byKey, tz, now, sub }: { item: ItemLike; byKey: Map<string, ItemLike>; tz: string; now: Date; sub?: string }) {
  const deps = unmetDependencies(item, byKey);
  const status = displayStatus(item, byKey);
  const overdue = isOverdue(item, now) && item.required;
  return (
    <li>
      <Link href={`/portal/items/${item.id}`} className="flex min-h-[60px] items-center gap-3 px-5 py-3 hover:bg-ink-50 active:bg-ink-100">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink-900">
            {item.title}
            {!item.required && <span className="ml-1.5 text-xs font-normal text-ink-400">Optional</span>}
          </p>
          <p className={clsx("mt-0.5 text-xs", overdue && status !== "blocked" ? "font-medium text-rose-700" : "text-ink-500")}>
            {sub ??
              (status === "blocked" ? (
                <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3 shrink-0" /> Waiting on {deps.map((d) => `“${d.title}”`).join(", ")}</span>
              ) : item.status === "changes_requested" ? (
                "The team asked for changes"
              ) : item.due_at ? (
                `${overdue ? "Overdue · was due" : "Due"} ${formatDate(item.due_at, tz)}`
              ) : (
                item.section_title
              ))}
          </p>
        </div>
        <StatusBadge status={status} />
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300" />
      </Link>
    </li>
  );
}
