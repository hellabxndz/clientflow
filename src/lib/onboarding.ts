export const ITEM_STATUSES = ["not_started", "in_progress", "submitted", "changes_requested", "approved"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const STATUS_LABEL: Record<ItemStatus, string> = {
  not_started: "Not Started",
  in_progress: "In Progress",
  submitted: "Submitted",
  changes_requested: "Changes Requested",
  approved: "Approved",
};

export const TASK_STATUS_LABEL: Record<ItemStatus, string> = {
  not_started: "To do",
  in_progress: "In progress",
  submitted: "In review",
  changes_requested: "Reopened",
  approved: "Done",
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
}

export interface OnboardingLike {
  id: string;
  status: "active" | "paused" | "completed" | "cancelled";
  owner_user_id: string | null;
}

export type BlockerReason = "overdue" | "changes_requested" | "awaiting_review" | "dependency" | "not_started";

export interface Blocker {
  itemId: string;
  title: string;
  section: string;
  reason: BlockerReason;
  waitingOn: "client" | "staff";
  ownerUserId: string | null;
  dueAt: Date | null;
  detail: string;
}

export type Stage = "completed" | "paused" | "cancelled" | "ready" | "review" | "waiting_client" | "internal";

export const STAGE_LABEL: Record<Stage, string> = {
  completed: "Completed",
  paused: "Paused",
  cancelled: "Cancelled",
  ready: "Ready to start",
  review: "Waiting for review",
  waiting_client: "Waiting on client",
  internal: "Internal work",
};

const toDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

export function isOverdue(item: ItemLike, now = new Date()) {
  const due = toDate(item.due_at);
  return !!due && due.getTime() < now.getTime() && item.status !== "approved" && item.status !== "submitted";
}

function dueSoon(item: ItemLike, now: Date) {
  const due = toDate(item.due_at);
  return !!due && due.getTime() - now.getTime() < 2 * 86400000;
}

/** Items this item depends on that are not yet approved. */
export function unmetDependencies(item: ItemLike, byKey: Map<string, ItemLike>) {
  return item.depends_on.map((k) => byKey.get(k)).filter((d): d is ItemLike => !!d && d.status !== "approved");
}

export function computeOnboardingState(onboarding: OnboardingLike, items: ItemLike[], now = new Date()) {
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const required = items.filter((i) => i.required);
  const requiredApproved = required.filter((i) => i.status === "approved").length;
  const clientItems = items.filter((i) => i.audience === "client");
  const clientDone = clientItems.filter((i) => i.status === "approved" || i.status === "submitted").length;
  const awaitingReview = items.filter((i) => i.status === "submitted");
  const overdue = items.filter((i) => isOverdue(i, now));
  const readyForCompletion = required.length > 0 && requiredApproved === required.length;

  const blockers: Blocker[] = [];
  for (const item of items) {
    if (item.status === "approved") continue;
    const deps = unmetDependencies(item, byKey);
    const base = {
      itemId: item.id,
      title: item.title,
      section: item.section_title,
      ownerUserId: item.owner_user_id ?? onboarding.owner_user_id,
      dueAt: toDate(item.due_at),
    };
    if (item.status === "submitted") {
      blockers.push({ ...base, reason: "awaiting_review", waitingOn: "staff", detail: "Submitted and waiting for staff review" });
    } else if (item.status === "changes_requested") {
      blockers.push({
        ...base,
        reason: "changes_requested",
        waitingOn: item.audience === "client" ? "client" : "staff",
        detail: "Changes were requested and not yet resubmitted",
      });
    } else if (deps.length > 0 && item.required && dueSoon(item, now)) {
      // Only surface dependency waits once the item is close to (or past) its due date.
      blockers.push({
        ...base,
        reason: "dependency",
        waitingOn: deps.some((d) => d.audience === "client") ? "client" : "staff",
        detail: `${isOverdue(item, now) ? "Overdue and waiting" : "Waiting"} on ${deps.map((d) => `"${d.title}"`).join(", ")}`,
      });
    } else if (isOverdue(item, now) && item.required) {
      blockers.push({
        ...base,
        reason: "overdue",
        waitingOn: item.audience === "client" ? "client" : "staff",
        detail: `Overdue since ${toDate(item.due_at)!.toDateString()}`,
      });
    }
  }

  let stage: Stage;
  if (onboarding.status === "completed") stage = "completed";
  else if (onboarding.status === "paused") stage = "paused";
  else if (onboarding.status === "cancelled") stage = "cancelled";
  else if (readyForCompletion) stage = "ready";
  else if (awaitingReview.length > 0) stage = "review";
  else if (clientItems.some((i) => i.required && i.status !== "approved" && i.status !== "submitted")) stage = "waiting_client";
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
    awaitingReview,
    overdue,
    blockers,
    readyForCompletion,
  };
}

/** What the client should do next, in order: changes requested, overdue, due soonest, then the rest. */
export function nextClientActions(items: ItemLike[], now = new Date()) {
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const open = items.filter(
    (i) => i.audience === "client" && (i.status === "not_started" || i.status === "in_progress" || i.status === "changes_requested"),
  );
  const score = (i: ItemLike) => {
    if (i.status === "changes_requested") return 0;
    if (isOverdue(i, now)) return 1;
    if (unmetDependencies(i, byKey).length > 0) return 4;
    return i.required ? 2 : 3;
  };
  return open.sort((a, b) => {
    const s = score(a) - score(b);
    if (s !== 0) return s;
    const da = toDate(a.due_at)?.getTime() ?? Infinity;
    const db = toDate(b.due_at)?.getTime() ?? Infinity;
    return da - db;
  });
}

/** Plain-language explanation of why an onboarding is blocked (non-AI fallback). */
export function explainBlockers(blockers: Blocker[], names: Map<string, string>) {
  if (blockers.length === 0) return ["Nothing is blocking this onboarding right now."];
  const client = blockers.filter((b) => b.waitingOn === "client");
  const staff = blockers.filter((b) => b.waitingOn === "staff");
  const lines: string[] = [];
  if (client.length)
    lines.push(
      `Waiting on the client for ${client.length} item${client.length === 1 ? "" : "s"}: ${client
        .slice(0, 4)
        .map((b) => `${b.title} (${b.detail.charAt(0).toLowerCase() + b.detail.slice(1)})`)
        .join("; ")}${client.length > 4 ? "; and more" : ""}.`,
    );
  if (staff.length)
    lines.push(
      `Waiting on the team for ${staff.length} item${staff.length === 1 ? "" : "s"}: ${staff
        .slice(0, 4)
        .map((b) => `${b.title}${b.ownerUserId ? ` (owner: ${names.get(b.ownerUserId) ?? "unknown"})` : " (no owner)"}`)
        .join("; ")}${staff.length > 4 ? "; and more" : ""}.`,
    );
  return lines;
}
