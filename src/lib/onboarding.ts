export const ITEM_STATUSES = ["not_started", "in_progress", "submitted", "under_review", "changes_requested", "approved"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type DisplayStatus = ItemStatus | "blocked";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  submitted: "Submitted",
  under_review: "Under Review",
  changes_requested: "Changes Requested",
  approved: "Approved",
  blocked: "Blocked",
};

export const TASK_STATUS_LABEL: Record<DisplayStatus, string> = {
  not_started: "To do",
  in_progress: "In progress",
  submitted: "In review",
  under_review: "In review",
  changes_requested: "Reopened",
  approved: "Done",
  blocked: "Blocked",
};

export interface ItemLike {
  id: string;
  item_key: string;
  title: string;
  kind: string;
  audience: "client" | "internal";
  required: boolean;
  status: ItemStatus;
  due_at: Date | string | null;
  owner_user_id: string | null;
  depends_on: string[];
  section_title: string;
  submitted_at?: Date | string | null;
  updated_at?: Date | string | null;
  status_changed_at?: Date | string | null;
  reviewed_at?: Date | string | null;
  weight?: number;
  critical?: boolean;
  reviewer_user_id?: string | null;
  removed_at?: Date | string | null;
  category?: string | null;
  config?: Record<string, unknown>;
}

export interface OnboardingLike {
  id: string;
  status: "active" | "paused" | "completed" | "cancelled";
  owner_user_id: string | null;
  kickoff_ready_at?: Date | string | null;
  kickoff_date?: Date | string | null;
  at_risk?: boolean;
}

export type BlockerCategory =
  | "waiting_on_client"
  | "waiting_on_staff"
  | "waiting_on_integration"
  | "dependency_blocked"
  | "document_rejected"
  | "deadline_overdue";

export const BLOCKER_LABEL: Record<BlockerCategory, string> = {
  waiting_on_client: "Waiting on client",
  waiting_on_staff: "Waiting on staff",
  waiting_on_integration: "Waiting on external integration",
  dependency_blocked: "Dependency blocked",
  document_rejected: "Document rejected",
  deadline_overdue: "Deadline overdue",
};

export type WaitingOn = "client" | "staff" | "integration";

export interface Blocker {
  itemId: string;
  title: string;
  section: string;
  kind: string;
  category: BlockerCategory;
  waitingOn: WaitingOn;
  /** Staff member responsible for moving it (reviewer or task owner); for client waits, the item or onboarding owner. */
  ownerUserId: string | null;
  dueAt: Date | null;
  since: Date | null;
  critical: boolean;
  /** Short reason shown next to the item. */
  detail: string;
  /** The item titles this blocker is waiting on (dependencies). */
  waitingFor?: string[];
}

export type Stage = "completed" | "paused" | "cancelled" | "ready" | "review" | "waiting_client" | "internal";

export const STAGE_LABEL: Record<Stage, string> = {
  completed: "Completed",
  paused: "Paused",
  cancelled: "Cancelled",
  ready: "Ready for Kickoff",
  review: "Waiting on Staff",
  waiting_client: "Waiting on Client",
  internal: "Internal work",
};

const DAY = 86400000;
const toDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
const live = <T extends ItemLike>(items: T[]) => items.filter((i) => !i.removed_at);

export function isAwaitingReview(status: string) {
  return status === "submitted" || status === "under_review";
}

export function isDone(status: string) {
  return status === "approved";
}

export function isOverdue(item: ItemLike, now = new Date()) {
  const due = toDate(item.due_at);
  return !!due && due.getTime() < now.getTime() && item.status !== "approved" && !isAwaitingReview(item.status);
}

function dueSoon(item: ItemLike, now: Date) {
  const due = toDate(item.due_at);
  return !!due && due.getTime() - now.getTime() < 2 * DAY;
}

export function daysBetween(from: Date, to: Date) {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
}

/** Items this item depends on that are not yet approved. */
export function unmetDependencies(item: ItemLike, byKey: Map<string, ItemLike>) {
  return item.depends_on
    .map((k) => byKey.get(k))
    .filter((d): d is ItemLike => !!d && !d.removed_at && d.status !== "approved");
}

/** Status shown to people: open items whose dependencies are unfinished show as Blocked. */
export function displayStatus(item: ItemLike, byKey: Map<string, ItemLike>): DisplayStatus {
  if ((item.status === "not_started" || item.status === "in_progress") && unmetDependencies(item, byKey).length > 0) return "blocked";
  return item.status;
}

function joinTitles(titles: string[]) {
  const q = titles.map((t) => `"${t}"`);
  if (q.length <= 1) return q.join("");
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Readiness score
// ---------------------------------------------------------------------------

export const READINESS_CREDIT = { approved: 1, awaitingReview: 0.5 } as const;
const CRITICAL_MULTIPLIER = 2;
const CRITICAL_BLOCKER_PENALTY = 3;
const MAX_PENALTY = 12;

export interface ReadinessLine {
  itemId: string;
  title: string;
  section: string;
  weight: number;
  credit: number;
  critical: boolean;
  status: ItemStatus;
}

export interface Readiness {
  /** 0-100, or null when the onboarding has no required items. */
  score: number | null;
  ready: ReadinessLine[];
  partial: ReadinessLine[];
  outstanding: ReadinessLine[];
  penalty: number;
  criticalBlockers: string[];
  explanation: string[];
}

/**
 * Readiness is computed only from the onboarding's live requirements:
 * - optional items never count;
 * - each required item carries its weight (critical items count double);
 * - approved items earn full credit, submitted or under-review items earn half;
 * - each critical item that is overdue or sent back costs 3 points (at most 12);
 * - 100% only when every required item is approved.
 */
export function computeReadiness(items: ItemLike[], now = new Date()): Readiness {
  const considered = live(items).filter((i) => i.required);
  const lines: ReadinessLine[] = considered.map((i) => ({
    itemId: i.id,
    title: i.title,
    section: i.section_title,
    weight: (i.weight ?? 1) * (i.critical ? CRITICAL_MULTIPLIER : 1),
    credit: i.status === "approved" ? READINESS_CREDIT.approved : isAwaitingReview(i.status) ? READINESS_CREDIT.awaitingReview : 0,
    critical: !!i.critical,
    status: i.status,
  }));
  if (lines.length === 0)
    return { score: null, ready: [], partial: [], outstanding: [], penalty: 0, criticalBlockers: [], explanation: ["This onboarding has no required items yet."] };

  const total = lines.reduce((s, l) => s + l.weight, 0);
  const earned = lines.reduce((s, l) => s + l.weight * l.credit, 0);
  const criticalBlockers = considered
    .filter((i) => i.critical && (isOverdue(i, now) || i.status === "changes_requested"))
    .map((i) => i.title);
  const penalty = Math.min(MAX_PENALTY, criticalBlockers.length * CRITICAL_BLOCKER_PENALTY);
  const allApproved = lines.every((l) => l.credit === 1);
  const raw = Math.round((earned / total) * 100);
  const score = allApproved ? 100 : Math.max(0, Math.min(99, raw - penalty));

  const ready = lines.filter((l) => l.credit === 1);
  const partial = lines.filter((l) => l.credit > 0 && l.credit < 1);
  const outstanding = lines.filter((l) => l.credit === 0);
  const explanation = [
    `${ready.length} of ${lines.length} required items are approved (full credit).`,
    partial.length
      ? `${partial.length} submitted item${partial.length === 1 ? " is" : "s are"} waiting for review (half credit until approved).`
      : null,
    outstanding.length ? `${outstanding.length} required item${outstanding.length === 1 ? " is" : "s are"} still outstanding.` : null,
    lines.some((l) => l.critical) ? "Critical items count double." : null,
    penalty
      ? `${penalty} points deducted for critical items that are overdue or sent back: ${criticalBlockers.join(", ")}.`
      : null,
    `Weighted progress: ${Math.round(earned * 10) / 10} of ${total} points${allApproved ? "" : ` = ${raw}%`}${penalty ? `, minus ${penalty}` : ""}. Optional items are not counted.`,
  ].filter((x): x is string => !!x);
  return { score, ready, partial, outstanding, penalty, criticalBlockers, explanation };
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

export function computeBlockers(onboarding: OnboardingLike, items: ItemLike[], now = new Date()): Blocker[] {
  const its = live(items);
  const byKey = new Map(its.map((i) => [i.item_key, i]));
  const blockers: Blocker[] = [];
  for (const item of its) {
    if (item.status === "approved") continue;
    const deps = unmetDependencies(item, byKey);
    const due = toDate(item.due_at);
    const changed = toDate(item.status_changed_at) ?? toDate(item.updated_at);
    const base = {
      itemId: item.id,
      title: item.title,
      section: item.section_title,
      kind: item.kind,
      dueAt: due,
      critical: !!item.critical,
    };
    if (isAwaitingReview(item.status)) {
      blockers.push({
        ...base,
        category: "waiting_on_staff",
        waitingOn: "staff",
        ownerUserId: item.reviewer_user_id ?? item.owner_user_id ?? onboarding.owner_user_id,
        since: toDate(item.submitted_at) ?? changed,
        detail: item.status === "under_review" ? "Under review" : "Submitted and waiting for review",
      });
    } else if (item.status === "changes_requested") {
      const isClient = item.audience === "client";
      blockers.push({
        ...base,
        category: item.kind === "file" ? "document_rejected" : isClient ? "waiting_on_client" : "waiting_on_staff",
        waitingOn: isClient ? "client" : "staff",
        ownerUserId: item.owner_user_id ?? onboarding.owner_user_id,
        since: toDate(item.reviewed_at) ?? changed,
        detail: item.kind === "file" ? "File sent back for a new version" : "Changes requested, not yet resubmitted",
      });
    } else if (deps.length > 0 && item.required && dueSoon(item, now)) {
      blockers.push({
        ...base,
        category: "dependency_blocked",
        waitingOn: deps.some((d) => d.audience === "client") ? "client" : "staff",
        ownerUserId: item.owner_user_id ?? onboarding.owner_user_id,
        since: due && due < now ? due : null,
        detail: `${isOverdue(item, now) ? "Overdue and waiting" : "Waiting"} on ${joinTitles(deps.map((d) => d.title))}`,
        waitingFor: deps.map((d) => d.title),
      });
    } else if (item.kind === "signature" && item.required && due && due < now) {
      blockers.push({
        ...base,
        category: "waiting_on_integration",
        waitingOn: "integration",
        ownerUserId: item.owner_user_id ?? onboarding.owner_user_id,
        since: due,
        detail: `Waiting on the e-signature${(item.config as { signature?: { provider?: string } } | undefined)?.signature?.provider ? ` in ${(item.config as { signature: { provider: string } }).signature.provider}` : ""}`,
      });
    } else if (isOverdue(item, now) && item.required) {
      blockers.push({
        ...base,
        category: "deadline_overdue",
        waitingOn: item.audience === "client" ? "client" : "staff",
        ownerUserId: item.owner_user_id ?? onboarding.owner_user_id,
        since: due,
        detail: `${daysBetween(due!, now)} day${daysBetween(due!, now) === 1 ? "" : "s"} overdue`,
      });
    }
  }
  // Critical first, then oldest.
  return blockers.sort(
    (a, b) => Number(b.critical) - Number(a.critical) || (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity),
  );
}

/** One plain-language sentence per blocker, grouping review waits by reviewer. */
export function explainBlockers(blockers: Blocker[], names: Map<string, string>): string[] {
  if (blockers.length === 0) return ["Nothing is blocking this onboarding right now."];
  const lines: string[] = [];
  const reviews = new Map<string, Blocker[]>();
  for (const b of blockers) {
    if (b.category === "waiting_on_staff" && (b.detail.startsWith("Submitted") || b.detail === "Under review")) {
      const k = b.ownerUserId ?? "";
      reviews.set(k, [...(reviews.get(k) ?? []), b]);
      continue;
    }
    switch (b.category) {
      case "deadline_overdue":
        lines.push(
          b.waitingOn === "client" && b.critical
            ? `Kickoff cannot be scheduled because ${b.title} is still missing (${b.detail}).`
            : b.waitingOn === "client"
              ? `${b.title} from the client is ${b.detail}.`
              : `Internal task "${b.title}" is ${b.detail}${b.ownerUserId ? ` (owner: ${names.get(b.ownerUserId) ?? "unassigned"})` : ""}.`,
        );
        break;
      case "dependency_blocked":
        lines.push(`"${b.title}" cannot start until ${joinTitles(b.waitingFor ?? [])} ${(b.waitingFor?.length ?? 0) > 1 ? "are" : "is"} approved.`);
        break;
      case "document_rejected":
        lines.push(`${b.title} needs a new upload: the last file was sent back${b.since ? ` ${relDays(b.since)}` : ""} and the client hasn't replaced it.`);
        break;
      case "waiting_on_client":
        lines.push(`${b.title} was sent back for changes and the client hasn't resubmitted it.`);
        break;
      case "waiting_on_staff":
        lines.push(`${b.title} needs the team's attention${b.ownerUserId ? ` (owner: ${names.get(b.ownerUserId) ?? "unassigned"})` : ""}.`);
        break;
      case "waiting_on_integration":
        lines.push(`${b.title} is ${b.detail.charAt(0).toLowerCase() + b.detail.slice(1)}.`);
        break;
    }
  }
  for (const [owner, list] of reviews) {
    const kinds = list.every((b) => b.kind === "file") ? "documents" : "submissions";
    lines.push(
      `Internal review is blocking this client. ${list.length} submitted ${list.length === 1 ? kinds.replace(/s$/, "") : kinds} ${list.length === 1 ? "is" : "are"} waiting on ${owner ? names.get(owner) ?? "an unassigned reviewer" : "an unassigned reviewer"}.`,
    );
  }
  return lines;
}

function relDays(d: Date) {
  const n = daysBetween(d, new Date());
  return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

// ---------------------------------------------------------------------------
// Projected kickoff
// ---------------------------------------------------------------------------

export function addBusinessDays(from: Date, days: number, businessDays: number[] = [1, 2, 3, 4, 5]) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (businessDays.includes(d.getUTCDay() === 0 ? 7 : d.getUTCDay())) added++;
  }
  return d;
}

export interface KickoffProjection {
  date: Date | null;
  basis: "scheduled" | "ready" | "estimate" | "none";
  note: string;
}

/**
 * Estimates kickoff from real due dates: the latest outstanding due date (or today if items are
 * overdue), plus one business day for review when client items are outstanding, plus the
 * workspace's kickoff lead time. It is an estimate, not a commitment.
 */
export function projectKickoff(
  onboarding: OnboardingLike,
  items: ItemLike[],
  opts: { now?: Date; leadDays?: number; businessDays?: number[] } = {},
): KickoffProjection {
  const now = opts.now ?? new Date();
  const lead = opts.leadDays ?? 2;
  if (onboarding.kickoff_date) return { date: new Date(onboarding.kickoff_date), basis: "scheduled", note: "Kickoff date confirmed." };
  if (onboarding.status === "completed" || onboarding.status === "cancelled") return { date: null, basis: "none", note: "" };
  const outstanding = live(items).filter((i) => i.required && i.status !== "approved");
  if (outstanding.length === 0)
    return {
      date: addBusinessDays(now, lead, opts.businessDays),
      basis: "ready",
      note: `All requirements are approved. Earliest kickoff with a ${lead}-business-day lead time.`,
    };
  if (onboarding.status === "paused") return { date: null, basis: "none", note: "Onboarding is paused." };
  const dues = outstanding.map((i) => toDate(i.due_at)).filter((d): d is Date => !!d);
  const future = dues.filter((d) => d > now);
  const overdue = outstanding.filter((i) => isOverdue(i, now)).length;
  const undated = outstanding.length - dues.length;
  let base = future.length ? new Date(Math.max(...future.map((d) => d.getTime()))) : now;
  if (base < now) base = now;
  const needsReview = outstanding.some((i) => i.audience === "client");
  const date = addBusinessDays(base, lead + (needsReview ? 1 : 0), opts.businessDays);
  const note = [
    `${future.length ? "Latest outstanding due date" : "Today"}${needsReview ? " + 1 business day for review" : ""} + ${lead}-business-day kickoff lead time.`,
    overdue ? `Assumes the ${overdue} overdue item${overdue === 1 ? " arrives" : "s arrive"} now.` : null,
    undated ? `${undated} item${undated === 1 ? " has" : "s have"} no due date.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return { date, basis: "estimate", note };
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

export function computeOnboardingState(onboarding: OnboardingLike, allItems: ItemLike[], now = new Date()) {
  const items = live(allItems);
  const required = items.filter((i) => i.required);
  const requiredApproved = required.filter((i) => i.status === "approved").length;
  const clientItems = items.filter((i) => i.audience === "client");
  const clientDone = clientItems.filter((i) => i.status === "approved" || isAwaitingReview(i.status)).length;
  const awaitingReview = items.filter((i) => isAwaitingReview(i.status));
  const overdue = items.filter((i) => isOverdue(i, now));
  const readyForCompletion = required.length > 0 && requiredApproved === required.length;
  const blockers = computeBlockers(onboarding, items, now);
  const readiness = computeReadiness(items, now);

  const active = onboarding.status === "active";
  const clientBlocked = blockers.some((b) => b.waitingOn === "client");
  const staffBlocked = blockers.some((b) => b.waitingOn === "staff");
  const integrationBlocked = blockers.some((b) => b.waitingOn === "integration");
  const waitingOn: WaitingOn | null = !active
    ? null
    : clientBlocked
      ? "client"
      : staffBlocked
        ? "staff"
        : integrationBlocked
          ? "integration"
          : null;
  const sinces = blockers.map((b) => b.since).filter((d): d is Date => !!d && d <= now);
  const blockedSince = active && sinces.length ? new Date(Math.min(...sinces.map((d) => d.getTime()))) : null;

  let stage: Stage;
  if (onboarding.status === "completed") stage = "completed";
  else if (onboarding.status === "paused") stage = "paused";
  else if (onboarding.status === "cancelled") stage = "cancelled";
  else if (onboarding.kickoff_ready_at || readyForCompletion) stage = "ready";
  else if (awaitingReview.length > 0 && !clientBlocked) stage = "review";
  else if (clientItems.some((i) => i.required && i.status !== "approved" && !isAwaitingReview(i.status))) stage = "waiting_client";
  else if (awaitingReview.length > 0) stage = "review";
  else stage = "internal";

  return {
    stage,
    progress: {
      requiredTotal: required.length,
      requiredApproved,
      percent: required.length ? Math.round((requiredApproved / required.length) * 100) : 0,
      clientTotal: clientItems.length,
      clientDone,
    },
    readiness,
    awaitingReview,
    overdue,
    blockers,
    waitingOn,
    blockedSince,
    blockedDays: blockedSince ? daysBetween(blockedSince, now) : 0,
    readyForCompletion,
    atRisk: !!onboarding.at_risk,
  };
}

export type OnboardingState = ReturnType<typeof computeOnboardingState>;

/** What the client should do next, in order: changes requested, overdue, due soonest, then the rest. */
export function nextClientActions<T extends ItemLike>(items: T[], now = new Date()) {
  const its = live(items);
  const byKey = new Map(its.map((i) => [i.item_key, i as ItemLike]));
  const open = its.filter(
    (i) => i.audience === "client" && (i.status === "not_started" || i.status === "in_progress" || i.status === "changes_requested"),
  );
  const score = (i: ItemLike) => {
    if (i.status === "changes_requested") return 0;
    if (unmetDependencies(i, byKey).length > 0) return 5;
    if (isOverdue(i, now)) return 1;
    if (i.critical) return 2;
    return i.required ? 3 : 4;
  };
  return open.sort((a, b) => {
    const s = score(a) - score(b);
    if (s !== 0) return s;
    const da = toDate(a.due_at)?.getTime() ?? Infinity;
    const db = toDate(b.due_at)?.getTime() ?? Infinity;
    return da - db;
  });
}
