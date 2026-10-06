import { describe, it, expect, beforeEach } from "vitest";
import { withSysTx, sysQuery } from "../src/lib/db";
import { runReminders, eligibleItems, type ReminderRule } from "../src/lib/reminders";
import { makeWorkspace, itemByKey, type Fixture } from "./fixtures";

// 11:00 in New York (EDT), 00:00 the next day in Tokyo.
const NOW = new Date("2026-03-10T15:00:00Z");
const DUE_PAST = "2026-03-07T22:00:00Z";

let w: Fixture;

async function setup(opts: { isDemo?: boolean; timezone?: string } = {}) {
  w = await makeWorkspace(opts);
  await withSysTx(async (tx) => {
    await tx.q("update onboarding_items set due_at = null, updated_at = $2 where workspace_id = $1", [w.workspaceId, NOW]);
    await tx.q("update onboarding_items set due_at = $2 where onboarding_id = $1 and item_key in ('business_profile', 'contacts')", [w.clientA.onboardingId, DUE_PAST]);
    await tx.q(
      `insert into reminder_rules (workspace_id, name, trigger, offset_days, repeat_every_days, send_hour, subject, body, enabled, previewed_at)
       values ($1, 'Overdue', 'overdue', 1, 3, 9, 'Still needed', E'Hi {{contact_name}}\n{{item_list}}', true, now())`,
      [w.workspaceId],
    );
  });
}

const emails = () => sysQuery<{ status: string; item_ids: string[]; to_email: string; error: string | null }>(
  "select status, item_ids, to_email, error from email_messages where workspace_id = $1 and kind = 'reminder'",
  [w.workspaceId],
);

describe("reminders", () => {
  beforeEach(async () => {
    await setup();
  });

  it("sends one reminder per contact for overdue client items, simulated in demo workspaces", async () => {
    const s = await runReminders({ now: NOW, workspaceId: w.workspaceId });
    expect(s.simulated).toBe(1);
    expect(s.sent).toBe(0);
    const rows = await emails();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("simulated");
    expect(rows[0].item_ids).toHaveLength(2);
  });

  it("never sends duplicates when run repeatedly", async () => {
    await runReminders({ now: NOW, workspaceId: w.workspaceId });
    const second = await runReminders({ now: new Date(NOW.getTime() + 3600_000), workspaceId: w.workspaceId });
    expect(second.simulated).toBe(0);
    expect(await emails()).toHaveLength(1);
    // Next day is inside the 3-day repeat window, so still nothing.
    await runReminders({ now: new Date(NOW.getTime() + 86400_000), workspaceId: w.workspaceId });
    expect(await emails()).toHaveLength(1);
    // After the repeat interval it reminds again.
    await runReminders({ now: new Date(NOW.getTime() + 3 * 86400_000), workspaceId: w.workspaceId });
    expect(await emails()).toHaveLength(2);
  });

  it("concurrent runs still produce a single email", async () => {
    await Promise.all([runReminders({ now: NOW, workspaceId: w.workspaceId }), runReminders({ now: NOW, workspaceId: w.workspaceId })]);
    expect(await emails()).toHaveLength(1);
  });

  it("stops once the requests are submitted or approved", async () => {
    await withSysTx((tx) => tx.q("update onboarding_items set status = 'submitted' where onboarding_id = $1 and item_key = 'business_profile'", [w.clientA.onboardingId]));
    await withSysTx((tx) => tx.q("update onboarding_items set status = 'approved' where onboarding_id = $1 and item_key = 'contacts'", [w.clientA.onboardingId]));
    await runReminders({ now: NOW, workspaceId: w.workspaceId });
    expect(await emails()).toHaveLength(0);
  });

  it("only includes items that still need the client", async () => {
    await withSysTx((tx) => tx.q("update onboarding_items set status = 'submitted' where onboarding_id = $1 and item_key = 'business_profile'", [w.clientA.onboardingId]));
    await runReminders({ now: NOW, workspaceId: w.workspaceId });
    const contacts = await itemByKey(w.clientA.onboardingId, "contacts");
    expect((await emails())[0].item_ids).toEqual([contacts.id]);
  });

  it("stops while the onboarding is paused, completed, or reminders are off for that client", async () => {
    for (const sql of [
      "update onboardings set status = 'paused' where id = $1",
      "update onboardings set status = 'completed' where id = $1",
      "update onboardings set status = 'active', reminders_enabled = false where id = $1",
    ]) {
      await withSysTx((tx) => tx.q(sql, [w.clientA.onboardingId]));
      await runReminders({ now: NOW, workspaceId: w.workspaceId });
      expect(await emails()).toHaveLength(0);
    }
  });

  it("stops when the rule is disabled", async () => {
    await withSysTx((tx) => tx.q("update reminder_rules set enabled = false where workspace_id = $1", [w.workspaceId]));
    await runReminders({ now: NOW, workspaceId: w.workspaceId });
    expect(await emails()).toHaveLength(0);
  });

  it("waits for the send hour in the client's time zone", async () => {
    await runReminders({ now: new Date("2026-03-10T12:00:00Z"), workspaceId: w.workspaceId }); // 8am New York
    expect(await emails()).toHaveLength(0);
    await runReminders({ now: new Date("2026-03-11T01:00:00Z"), workspaceId: w.workspaceId }); // 9pm New York: quiet hours
    expect(await emails()).toHaveLength(0);
  });

  it("uses each client's own time zone", async () => {
    await setup({ timezone: "Asia/Tokyo" });
    await runReminders({ now: NOW, workspaceId: w.workspaceId }); // midnight in Tokyo
    expect(await emails()).toHaveLength(0);
    await runReminders({ now: new Date("2026-03-11T01:00:00Z"), workspaceId: w.workspaceId }); // 10am Tokyo
    expect(await emails()).toHaveLength(1);
  });

  it("records a failure instead of sending when no provider is configured in a live workspace", async () => {
    await setup({ isDemo: false });
    const s = await runReminders({ now: NOW, workspaceId: w.workspaceId });
    expect(s.failed).toBe(1);
    const [row] = await emails();
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no email provider/i);
  });

  it("a rule cannot be enabled without a preview", async () => {
    await expect(
      withSysTx((tx) =>
        tx.q(
          "insert into reminder_rules (workspace_id, name, trigger, subject, body, enabled) values ($1, 'x', 'overdue', 's', '{{item_list}}', true)",
          [w.workspaceId],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("eligibility rules", () => {
  const base: ReminderRule = {
    id: "r", workspace_id: "w", name: "r", trigger: "before_due", offset_days: 2, repeat_every_days: null, send_hour: 9,
    subject: "", body: "", enabled: true, previewed_at: new Date(),
  };
  const item = (due: string | null, status = "not_started") => ({ id: "i", title: "t", due_at: due ? new Date(due) : null, status, updated_at: NOW, audience: "client" });

  it("before-due reminders fire within the window and only once", () => {
    expect(eligibleItems(base, [item("2026-03-12T17:00:00Z")], new Map(), NOW, "America/New_York")).toHaveLength(1);
    expect(eligibleItems(base, [item("2026-03-20T17:00:00Z")], new Map(), NOW, "America/New_York")).toHaveLength(0);
    expect(eligibleItems(base, [item("2026-03-12T17:00:00Z")], new Map([["i", new Date("2026-03-09T15:00:00Z")]]), NOW, "America/New_York")).toHaveLength(0);
  });

  it("ignores internal items and finished items", () => {
    expect(eligibleItems(base, [{ ...item("2026-03-11T17:00:00Z"), audience: "internal" }], new Map(), NOW, "UTC")).toHaveLength(0);
    expect(eligibleItems(base, [item("2026-03-11T17:00:00Z", "approved")], new Map(), NOW, "UTC")).toHaveLength(0);
  });
});
