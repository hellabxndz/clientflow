import { describe, it, expect, beforeEach } from "vitest";
import { withSysTx, withTenant } from "../src/lib/db";
import { processPendingEvents, runTimeTriggers } from "../src/lib/automation/engine";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;

async function addRule(r: {
  trigger: string;
  actions: unknown[];
  conditions?: unknown[];
  conditionMode?: "all" | "any";
  runMode?: "once_per_onboarding" | "every_event";
  triggerConfig?: Record<string, unknown>;
  enabled?: boolean;
}) {
  return withSysTx(async (tx) =>
    (await tx.one<{ id: string }>(
      `insert into automation_rules (workspace_id, name, enabled, trigger, trigger_config, conditions, condition_mode, actions, run_mode)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        w.workspaceId,
        `Rule ${r.trigger}`,
        r.enabled ?? true,
        r.trigger,
        JSON.stringify(r.triggerConfig ?? {}),
        JSON.stringify(r.conditions ?? []),
        r.conditionMode ?? "all",
        JSON.stringify(r.actions),
        r.runMode ?? "once_per_onboarding",
      ],
    ))!.id,
  );
}

const setStatus = (keys: string[], status: string, onboardingId = w.clientA.onboardingId) =>
  withTenant(w.ctx.staff, (tx) => tx.q("update onboarding_items set status = $3 where onboarding_id = $1 and item_key = any($2)", [onboardingId, keys, status]));

const runs = (ruleId: string) =>
  withSysTx((tx) => tx.q<{ status: string; dedupe_key: string; results: { status: string; detail: string }[] }>("select * from automation_runs where rule_id = $1", [ruleId]));

const notes = (onboardingId = w.clientA.onboardingId) =>
  withSysTx((tx) => tx.q<{ body: string }>("select body from comments where onboarding_id = $1 and source = 'automation'", [onboardingId]));

describe("automation engine", () => {
  beforeEach(async () => {
    w = await makeWorkspace();
    // Onboarding-created events from the fixture aren't under test.
    await processPendingEvents({ workspaceId: w.workspaceId });
  });

  it("status changes are recorded as events and item history by the database", async () => {
    await setStatus(["business_profile"], "submitted");
    const [ev] = await withSysTx((tx) => tx.q<{ type: string; payload: { itemKey: string } }>("select type, payload from automation_events where workspace_id = $1 and processed_at is null", [w.workspaceId]));
    expect(ev.type).toBe("form_submitted");
    expect(ev.payload.itemKey).toBe("business_profile");
    const hist = await withSysTx((tx) =>
      tx.q<{ from_status: string; to_status: string; actor_role: string }>(
        "select h.from_status, h.to_status, h.actor_role from item_status_history h join onboarding_items i on i.id = h.item_id where i.onboarding_id = $1 and i.item_key = 'business_profile' order by h.id",
        [w.clientA.onboardingId],
      ),
    );
    expect(hist.map((h) => h.to_status)).toEqual(["not_started", "submitted"]);
    expect(hist[1].actor_role).toBe("staff");
  });

  it("runs a once-per-onboarding rule exactly once, however often events are processed", async () => {
    const rule = await addRule({ trigger: "item_submitted", actions: [{ type: "add_note", body: "Submitted: {{item_title}}" }] });
    await setStatus(["business_profile"], "submitted");
    await Promise.all([processPendingEvents({ workspaceId: w.workspaceId }), processPendingEvents({ workspaceId: w.workspaceId })]);
    await processPendingEvents({ workspaceId: w.workspaceId });
    await setStatus(["goals_audience"], "submitted");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(1);
    expect(await notes()).toHaveLength(1);
  });

  it("every-event rules run once per event, never twice for the same event", async () => {
    const rule = await addRule({ trigger: "item_submitted", runMode: "every_event", actions: [{ type: "add_note", body: "{{item_title}}" }] });
    await setStatus(["business_profile"], "submitted");
    await setStatus(["goals_audience"], "submitted");
    await processPendingEvents({ workspaceId: w.workspaceId });
    await processPendingEvents({ workspaceId: w.workspaceId });
    // Re-processing an already handled event must not run actions again.
    await withSysTx((tx) => tx.q("update automation_events set processed_at = null where workspace_id = $1", [w.workspaceId]));
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(2);
    expect(await notes()).toHaveLength(2);
  });

  it("disabled rules don't run", async () => {
    const rule = await addRule({ trigger: "item_submitted", enabled: false, actions: [{ type: "add_note", body: "x" }] });
    await setStatus(["business_profile"], "submitted");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(0);
  });

  it("AND conditions: marks Ready for Kickoff only when ads access, brand assets and kickoff questionnaire are all in", async () => {
    const rule = await addRule({
      trigger: "item_approved",
      conditions: [
        { type: "item_status", itemKey: "access_google_ads", state: "approved" },
        { type: "section_complete", sectionKey: "brand" },
        { type: "item_status", itemKey: "kickoff_prefs", state: "submitted" },
      ],
      actions: [{ type: "mark_ready_for_kickoff" }],
    });
    const ready = () => withSysTx(async (tx) => (await tx.one<{ kickoff_ready_at: Date | null }>("select kickoff_ready_at from onboardings where id = $1", [w.clientA.onboardingId]))!.kickoff_ready_at);

    await setStatus(["access_google_ads"], "approved");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await ready()).toBeNull();
    expect(await runs(rule)).toHaveLength(0);

    await setStatus(["logo_files", "brand_guidelines", "creative_questionnaire"], "approved");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await ready()).toBeNull();

    // "Submitted" is satisfied by approved too; the next approval re-evaluates the rule.
    await setStatus(["kickoff_prefs"], "submitted");
    await setStatus(["business_profile"], "approved");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await ready()).not.toBeNull();
    expect(await runs(rule)).toHaveLength(1);
    // Marking ready emits ready_for_kickoff for handoff rules.
    const evs = await withSysTx((tx) => tx.q("select 1 from automation_events where onboarding_id = $1 and type = 'ready_for_kickoff'", [w.clientA.onboardingId]));
    expect(evs).toHaveLength(1);
  });

  it("ANY conditions run when one condition holds", async () => {
    const rule = await addRule({
      trigger: "item_approved",
      conditionMode: "any",
      conditions: [
        { type: "item_status", itemKey: "contacts", state: "approved" },
        { type: "item_status", itemKey: "goals_audience", state: "approved" },
      ],
      actions: [{ type: "add_note", body: "one of them" }],
    });
    await setStatus(["goals_audience"], "approved");
    await processPendingEvents({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(1);
  });

  it("time-based escalations run once per overdue item, notify the right staff, and demo workspaces send nothing", async () => {
    const rule = await addRule({
      trigger: "deadline_overdue",
      triggerConfig: { days: 3 },
      actions: [
        { type: "notify_staff", to: "account_manager", message: "{{client_name}}: {{item_title}} is late", email: true },
        { type: "chat_notification", provider: "slack", message: "late" },
      ],
    });
    await withSysTx((tx) => tx.q("update clients set owner_user_id = $2 where id = $1", [w.clientA.id, w.staffId]));
    await withSysTx((tx) =>
      tx.q("update onboarding_items set due_at = now() - interval '4 days' where onboarding_id = $1 and item_key = 'business_profile'", [w.clientA.onboardingId]),
    );
    const later = new Date(Date.now() + 3600_000);
    await runTimeTriggers({ workspaceId: w.workspaceId });
    await runTimeTriggers({ workspaceId: w.workspaceId, now: later });
    const r = await runs(rule);
    expect(r).toHaveLength(1);
    expect(r[0].results.find((x) => x.status === "done")?.detail).toMatch(/Notified/);
    // Slack isn't sent from a demo workspace.
    expect(r[0].results[1].status).toBe("skipped");
    const n = await withTenant(w.ctx.staff, (tx) => tx.q<{ title: string }>("select title from notifications"));
    expect(n).toHaveLength(1);
    const emails = await withSysTx((tx) => tx.q<{ status: string }>("select status from email_messages where workspace_id = $1 and kind = 'notification'", [w.workspaceId]));
    expect(emails.map((e) => e.status)).toEqual(["simulated"]);
    // Optional items never escalate.
    await withSysTx((tx) =>
      tx.q("update onboarding_items set due_at = now() - interval '9 days' where onboarding_id = $1 and not required", [w.clientA.onboardingId]),
    );
    await runTimeTriggers({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(1);
  });

  it("client inactivity flags the onboarding At Risk once", async () => {
    const rule = await addRule({
      trigger: "client_inactive",
      triggerConfig: { days: 10 },
      actions: [{ type: "update_stage", stage: "at_risk", reason: "No client activity for 10 days" }],
    });
    await withSysTx((tx) => tx.q("update onboardings set last_client_activity_at = now() - interval '11 days' where id = $1", [w.clientA.onboardingId]));
    await runTimeTriggers({ workspaceId: w.workspaceId });
    await runTimeTriggers({ workspaceId: w.workspaceId });
    expect(await runs(rule)).toHaveLength(1);
    const o = await withSysTx((tx) => tx.one<{ at_risk: boolean; at_risk_reason: string }>("select at_risk, at_risk_reason from onboardings where id = $1", [w.clientA.onboardingId]));
    expect(o!.at_risk).toBe(true);
    expect(o!.at_risk_reason).toMatch(/10 days/);
    // Client B was active recently (fixture default), so it isn't flagged.
    const b = await withSysTx((tx) => tx.one<{ at_risk: boolean }>("select at_risk from onboardings where id = $1", [w.clientB.onboardingId]));
    expect(b!.at_risk).toBe(false);
  });

  it("rules never act on another workspace's onboardings", async () => {
    const other = await makeWorkspace();
    await processPendingEvents({ workspaceId: other.workspaceId });
    const rule = await addRule({ trigger: "item_submitted", runMode: "every_event", actions: [{ type: "add_note", body: "x" }] });
    await withTenant(other.ctx.staff, (tx) =>
      tx.q("update onboarding_items set status = 'submitted' where onboarding_id = $1 and item_key = 'business_profile'", [other.clientA.onboardingId]),
    );
    await processPendingEvents();
    expect(await runs(rule)).toHaveLength(0);
    expect(await notes(other.clientA.onboardingId)).toHaveLength(0);
  });
});

describe("completion guard", () => {
  it("an onboarding can't be completed while required items are unapproved, whatever the code path", async () => {
    w = await makeWorkspace();
    await expect(withTenant(w.ctx.admin, (tx) => tx.q("update onboardings set status = 'completed' where id = $1", [w.clientA.onboardingId]))).rejects.toThrow(
      /required items/,
    );
    await withTenant(w.ctx.admin, (tx) => tx.q("update onboarding_items set status = 'approved' where onboarding_id = $1 and required", [w.clientA.onboardingId]));
    await withTenant(w.ctx.admin, (tx) => tx.q("update onboardings set status = 'completed', completed_at = now() where id = $1", [w.clientA.onboardingId]));
    const o = await withSysTx((tx) => tx.one<{ status: string }>("select status from onboardings where id = $1", [w.clientA.onboardingId]));
    expect(o!.status).toBe("completed");
  });
});
