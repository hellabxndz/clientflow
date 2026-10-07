import { describe, it, expect, beforeAll } from "vitest";
import { withSysTx, withTenant } from "../src/lib/db";
import { applyTemplateUpgrade, planTemplateUpgrade, publishTemplate, type TemplateContent } from "../src/lib/templates";
import { AGENCY_TEMPLATE } from "../src/lib/template-library";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;
const items = (onboardingId: string) =>
  withSysTx((tx) => tx.q<{ item_key: string; title: string; status: string; removed_at: Date | null; source_version: number }>(
    "select item_key, title, status, removed_at, source_version from onboarding_items where onboarding_id = $1", [onboardingId]));

beforeAll(async () => {
  w = await makeWorkspace();
  // Client A has started two items before the template changes.
  await withTenant(w.ctx.staff, (tx) =>
    tx.q("update onboarding_items set status = 'submitted' where onboarding_id = $1 and item_key in ('business_profile', 'contacts')", [w.clientA.onboardingId]));
  const edited: TemplateContent = structuredClone(AGENCY_TEMPLATE.content);
  for (const s of edited.sections)
    for (const i of s.items) {
      if (i.key === "business_profile") i.title = "Business details (v2)"; // started: must be kept
      if (i.key === "goals_audience") i.title = "Goals (v2)"; // untouched: may update
    }
  for (const s of edited.sections) s.items = s.items.filter((i) => i.key !== "contacts" && i.key !== "anything_else");
  edited.sections[0].items.push({ key: "w9", kind: "file", title: "W-9 form", audience: "client", required: true, file: { accept: ["pdf"], maxSizeMb: 10 } });
  await withTenant(w.ctx.admin, async (tx) => {
    await tx.q("update templates set draft = $2 where id = $1", [w.templateId, JSON.stringify(edited)]);
    await publishTemplate(tx, w.templateId, w.adminId);
  });
});

describe("explicit template upgrades", () => {
  it("publishing a new version changes nothing in live onboardings by itself", async () => {
    const list = await items(w.clientA.onboardingId);
    expect(list.find((i) => i.item_key === "business_profile")!.title).not.toMatch(/v2/);
    expect(list.some((i) => i.item_key === "w9")).toBe(false);
  });

  it("the upgrade plan shows what will change and protects started work", async () => {
    const plan = await withTenant(w.ctx.admin, (tx) => planTemplateUpgrade(tx, w.clientA.onboardingId));
    expect(plan!.toVersion).toBe(2);
    expect(plan!.added.map((a) => a.key)).toEqual(["w9"]);
    expect(plan!.updated.map((u) => u.key)).toContain("goals_audience");
    expect(plan!.keptStarted.map((k) => k.key)).toContain("business_profile");
    expect(plan!.removed.map((r) => r.key)).toEqual(["anything_else"]);
    expect(plan!.keptRemoved.map((r) => r.key)).toEqual(["contacts"]);
  });

  it("applying it upgrades only untouched items and leaves other onboardings alone", async () => {
    await withTenant(w.ctx.admin, (tx) => applyTemplateUpgrade(tx, w.clientA.onboardingId));
    const by = Object.fromEntries((await items(w.clientA.onboardingId)).map((i) => [i.item_key, i]));
    expect(by.goals_audience.title).toBe("Goals (v2)");
    expect(by.business_profile.title).not.toMatch(/v2/);
    expect(by.business_profile.status).toBe("submitted");
    expect(by.w9.source_version).toBe(2);
    expect(by.anything_else.removed_at).not.toBeNull();
    expect(by.contacts.removed_at).toBeNull();
    const onb = await withSysTx((tx) => tx.one<{ template_version: number; upgraded_at: Date }>("select template_version, upgraded_at from onboardings where id = $1", [w.clientA.onboardingId]));
    expect(onb!.template_version).toBe(2);
    expect(onb!.upgraded_at).not.toBeNull();
    // Client B was not upgraded.
    expect((await items(w.clientB.onboardingId)).some((i) => i.item_key === "w9")).toBe(false);
    await expect(withTenant(w.ctx.admin, (tx) => applyTemplateUpgrade(tx, w.clientA.onboardingId))).rejects.toThrow(/latest/);
  });

  it("removed requirements disappear from the client's portal", async () => {
    const visible = await withTenant(w.ctx.clientA, (tx) => tx.q<{ item_key: string }>("select item_key from onboarding_items"));
    expect(visible.some((i) => i.item_key === "anything_else")).toBe(false);
  });
});
