import { describe, it, expect } from "vitest";
import { computeOnboardingState, nextClientActions, type ItemLike, type ItemStatus } from "../src/lib/onboarding";
import { ruleBasedFlags } from "../src/lib/ai";
import { validateField } from "../src/lib/form-validation";

const NOW = new Date("2026-03-10T12:00:00Z");
let n = 0;
const item = (key: string, over: Partial<ItemLike> = {}): ItemLike => ({
  id: `id-${++n}`, item_key: key, title: key, kind: "form", audience: "client", required: true, status: "not_started" as ItemStatus,
  due_at: null, owner_user_id: null, depends_on: [], section_title: "S", ...over,
});
const onb = { id: "o", status: "active" as const, owner_user_id: "owner" };

describe("onboarding state", () => {
  it("is ready to start only when every required item is approved", () => {
    const items = [item("a", { status: "approved" }), item("b", { status: "approved", audience: "internal", kind: "task" }), item("c", { required: false })];
    const s = computeOnboardingState(onb, items, NOW);
    expect(s.readyForCompletion).toBe(true);
    expect(s.stage).toBe("ready");
    const s2 = computeOnboardingState(onb, [...items, item("d", { status: "submitted" })], NOW);
    expect(s2.readyForCompletion).toBe(false);
    expect(s2.stage).toBe("review");
  });

  it("explains blockers with who they're waiting on", () => {
    const items = [
      item("profile", { due_at: "2026-03-01T00:00:00Z" }),
      item("logo", { status: "changes_requested" }),
      item("brief", { audience: "internal", kind: "task", depends_on: ["profile"], owner_user_id: "u1", due_at: "2026-03-11T00:00:00Z" }),
      item("later", { audience: "internal", kind: "task", depends_on: ["profile"], due_at: "2026-03-30T00:00:00Z" }),
      item("review", { status: "submitted" }),
    ];
    const s = computeOnboardingState(onb, items, NOW);
    const by = Object.fromEntries(s.blockers.map((b) => [b.title, b]));
    expect(by.profile.category).toBe("deadline_overdue");
    expect(by.profile.waitingOn).toBe("client");
    expect(by.logo.category).toBe("waiting_on_client");
    expect(by.brief.category).toBe("dependency_blocked");
    expect(by.brief.waitingOn).toBe("client");
    expect(by.review.category).toBe("waiting_on_staff");
    expect(by.review.waitingOn).toBe("staff");
    // Dependency waits on items that aren't due soon are not treated as blockers yet.
    expect(by.later).toBeUndefined();
  });

  it("paused and completed onboardings report their status", () => {
    expect(computeOnboardingState({ ...onb, status: "paused" }, [item("a")], NOW).stage).toBe("paused");
    expect(computeOnboardingState({ ...onb, status: "completed" }, [item("a", { status: "approved" })], NOW).stage).toBe("completed");
  });

  it("orders the client's next actions: changes requested, overdue, then by due date", () => {
    const list = nextClientActions(
      [
        item("later", { due_at: "2026-03-20T00:00:00Z" }),
        item("soon", { due_at: "2026-03-12T00:00:00Z" }),
        item("late", { due_at: "2026-03-01T00:00:00Z" }),
        item("fix", { status: "changes_requested" }),
        item("done", { status: "submitted" }),
        item("internal", { audience: "internal" }),
      ],
      NOW,
    );
    expect(list.map((i) => i.item_key)).toEqual(["fix", "late", "soon", "later"]);
  });
});

describe("non-AI assistance and validation", () => {
  it("flags missing and malformed answers without AI", () => {
    const flags = ruleBasedFlags([
      {
        ...item("p", { status: "submitted" }),
        response: { email: "not-an-email", site: "example" },
        config: { fields: [
          { key: "email", label: "Email", type: "email", required: true },
          { key: "site", label: "Website", type: "url", required: true },
          { key: "name", label: "Name", type: "text", required: true },
        ] },
        document_count: 0,
      },
    ]);
    expect(flags).toHaveLength(3);
  });

  it("validates field types only on submit", () => {
    const f = { key: "e", label: "Email", type: "email" as const, required: true };
    expect(validateField(f, "bad", false).error).toBeUndefined();
    expect(validateField(f, "bad", true).error).toBeDefined();
    expect(validateField(f, "", true).error).toMatch(/required/);
    expect(validateField({ key: "s", label: "S", type: "select", required: true, options: ["A"] }, "B", true).error).toBeDefined();
  });
});
