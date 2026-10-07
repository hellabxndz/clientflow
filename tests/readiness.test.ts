import { describe, it, expect } from "vitest";
import { computeOnboardingState, computeReadiness, explainBlockers, projectKickoff, type ItemLike, type ItemStatus } from "../src/lib/onboarding";

const NOW = new Date("2026-10-07T12:00:00Z");
let n = 0;
const item = (key: string, over: Partial<ItemLike> = {}): ItemLike => ({
  id: `id-${++n}`, item_key: key, title: key, kind: "form", audience: "client", required: true, status: "not_started" as ItemStatus,
  due_at: null, owner_user_id: null, depends_on: [], section_title: "S", weight: 1, critical: false, ...over,
});
const onb = { id: "o", status: "active" as const, owner_user_id: "owner" };

describe("readiness score", () => {
  it("is 100 only when every required item is approved; optional items never count", () => {
    expect(computeReadiness([item("a", { status: "approved" }), item("b", { required: false })], NOW).score).toBe(100);
    const r = computeReadiness([item("a", { status: "approved" }), item("b", { status: "approved" }), item("c", { status: "submitted" })], NOW);
    expect(r.score).toBeLessThan(100);
  });

  it("gives submitted and under-review items half credit", () => {
    const r = computeReadiness([item("a", { status: "approved" }), item("b", { status: "submitted" }), item("c", { status: "under_review" }), item("d")], NOW);
    // (1 + 0.5 + 0.5 + 0) / 4
    expect(r.score).toBe(50);
    expect(r.partial).toHaveLength(2);
    expect(r.outstanding).toHaveLength(1);
  });

  it("uses per-requirement weights and counts critical items double", () => {
    const r = computeReadiness([item("big", { status: "approved", weight: 3 }), item("small", { weight: 1 })], NOW);
    expect(r.score).toBe(75);
    const c = computeReadiness([item("crit", { weight: 1, critical: true }), item("x", { status: "approved", weight: 2 })], NOW);
    expect(c.score).toBe(50);
  });

  it("critical blockers (overdue or sent back) cost points, capped", () => {
    const base = [item("ok", { status: "approved", weight: 6 }), item("ads", { critical: true, weight: 2 })];
    const clean = computeReadiness(base, NOW).score!;
    const overdue = computeReadiness([base[0], { ...base[1], due_at: "2026-10-01T17:00:00Z" }], NOW);
    expect(overdue.score).toBe(clean - 3);
    expect(overdue.criticalBlockers).toEqual(["ads"]);
    const many = computeReadiness(
      [item("ok", { status: "approved", weight: 10 }), ...Array.from({ length: 6 }, (_, i) => item(`c${i}`, { status: "changes_requested", critical: true }))],
      NOW,
    );
    expect(many.penalty).toBe(12);
  });

  it("explains the score in plain language", () => {
    const r = computeReadiness([item("a", { status: "approved" }), item("b", { status: "submitted" }), item("c", { critical: true, status: "changes_requested" })], NOW);
    expect(r.explanation.join(" ")).toMatch(/1 of 3 required items are approved/);
    expect(r.explanation.join(" ")).toMatch(/waiting for review/);
    expect(r.explanation.join(" ")).toMatch(/points deducted/);
  });

  it("removed requirements don't count", () => {
    expect(computeReadiness([item("a", { status: "approved" }), item("gone", { removed_at: "2026-10-01T00:00:00Z" })], NOW).score).toBe(100);
  });
});

describe("blocker intelligence", () => {
  it("categorizes blockers and says who they wait on", () => {
    const items = [
      item("ads", { title: "Google Ads access", kind: "access", due_at: "2026-10-05T17:00:00Z" }),
      item("logo", { title: "Final logo files", kind: "file", status: "changes_requested" }),
      item("brand", { title: "Brand guide", kind: "file", status: "submitted", reviewer_user_id: "sarah", submitted_at: "2026-10-05T12:00:00Z" }),
      item("photos", { title: "Photos", kind: "file", status: "submitted", reviewer_user_id: "sarah", submitted_at: "2026-10-06T12:00:00Z" }),
      item("review", { title: "Final creative review", kind: "task", audience: "internal", depends_on: ["logo"], due_at: "2026-10-08T17:00:00Z" }),
    ];
    const s = computeOnboardingState(onb, items, NOW);
    const by = Object.fromEntries(s.blockers.map((b) => [b.title, b]));
    expect(by["Google Ads access"].category).toBe("deadline_overdue");
    expect(by["Final logo files"].category).toBe("document_rejected");
    expect(by["Brand guide"].category).toBe("waiting_on_staff");
    expect(by["Final creative review"].category).toBe("dependency_blocked");
    expect(by["Final creative review"].waitingOn).toBe("client");
    expect(s.waitingOn).toBe("client");
    expect(s.blockedDays).toBe(2);
    const text = explainBlockers(s.blockers, new Map([["sarah", "Sarah"]])).join(" ");
    expect(text).toMatch(/Sarah/);
    expect(text).toMatch(/Google Ads access/);
  });
});

describe("projected kickoff", () => {
  it("uses the confirmed kickoff date when set", () => {
    const k = projectKickoff({ ...onb, kickoff_date: "2026-10-12" }, [item("a")], { now: NOW });
    expect(k.basis).toBe("scheduled");
    expect(k.date!.toISOString().slice(0, 10)).toBe("2026-10-12");
  });

  it("estimates from the latest outstanding due date plus review and lead time, skipping weekends", () => {
    // Due Friday Oct 9, + 1 review day + 2 lead days = Wed Oct 14.
    const k = projectKickoff(onb, [item("a", { due_at: "2026-10-09T17:00:00Z" })], { now: NOW, leadDays: 2 });
    expect(k.basis).toBe("estimate");
    expect(k.date!.toISOString().slice(0, 10)).toBe("2026-10-14");
  });

  it("has no projection for paused onboardings with outstanding items", () => {
    expect(projectKickoff({ ...onb, status: "paused" }, [item("a")], { now: NOW }).date).toBeNull();
  });
});
