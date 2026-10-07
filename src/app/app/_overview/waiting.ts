import type { Blocker, WaitingOn } from "@/lib/onboarding";

const isReview = (b: Blocker) => b.category === "waiting_on_staff" && (b.detail.startsWith("Submitted") || b.detail === "Under review");

function list(titles: string[], max = 2) {
  const uniq = [...new Set(titles)];
  if (uniq.length <= max) return uniq.length === 2 ? `${uniq[0]} and ${uniq[1]}` : uniq[0] ?? "";
  return `${uniq.slice(0, max).join(", ")} and ${uniq.length - max} more`;
}

/** A short "Waiting on …" line for the party the onboarding is waiting on, derived from its blockers. */
export function waitingOnLine(blockers: Blocker[], waitingOn: WaitingOn | null): string | null {
  if (blockers.length === 0) return null;
  const who = waitingOn ?? blockers[0].waitingOn;
  const relevant = blockers.filter((b) => b.waitingOn === who);
  if (who === "client") {
    const rejected = relevant.filter((b) => b.category === "document_rejected" || b.category === "waiting_on_client");
    const missing = relevant.filter((b) => !rejected.includes(b));
    const parts: string[] = [];
    if (missing.length) parts.push(list(missing.map((b) => b.title)));
    if (rejected.length) parts.push(`${rejected.length === 1 ? "a new version of " : "new versions of "}${list(rejected.map((b) => b.title), 1)}`);
    return `Waiting on ${parts.join(" and ")}`;
  }
  if (who === "staff") {
    const reviews = relevant.filter(isReview);
    const tasks = relevant.filter((b) => !isReview(b));
    const parts: string[] = [];
    if (reviews.length) parts.push(reviews.every((b) => b.kind === "file") ? "internal document review" : "internal review");
    if (tasks.length) parts.push(list(tasks.map((b) => b.title), 1));
    return `Waiting on ${parts.join(" and ")}`;
  }
  return `Waiting on ${list(relevant.map((b) => b.title), 1)} (external integration)`;
}
