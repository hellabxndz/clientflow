import { describe, it, expect, beforeAll } from "vitest";
import { withSysTx, withTenant } from "../src/lib/db";
import { createOnboardingFromTemplate, publishTemplate, validateTemplateContent, type TemplateContent } from "../src/lib/templates";
import { AGENCY_TEMPLATE, ACCOUNTING_TEMPLATE } from "../src/lib/template-library";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;
beforeAll(async () => {
  w = await makeWorkspace();
});

describe("template versioning", () => {
  it("existing onboardings keep their version when the template changes", async () => {
    const before = await withSysTx((tx) => tx.q<{ item_key: string; title: string }>("select item_key, title from onboarding_items where onboarding_id = $1 order by position", [w.clientA.onboardingId]));

    const edited: TemplateContent = structuredClone(AGENCY_TEMPLATE.content);
    edited.sections[0].items[0].title = "Company profile (updated)";
    edited.sections[0].items.push({ key: "w9", kind: "file", title: "W-9 form", audience: "client", required: true, file: { accept: ["pdf"], maxSizeMb: 10 } });
    await withTenant(w.ctx.admin, async (tx) => {
      await tx.q("update templates set draft = $2 where id = $1", [w.templateId, JSON.stringify(edited)]);
      const v = await publishTemplate(tx, w.templateId, w.adminId);
      expect(v.version).toBe(2);
    });

    const after = await withSysTx((tx) => tx.q<{ item_key: string; title: string }>("select item_key, title from onboarding_items where onboarding_id = $1 order by position", [w.clientA.onboardingId]));
    expect(after).toEqual(before);
    const onb = await withSysTx((tx) => tx.one<{ template_version: number }>("select template_version from onboardings where id = $1", [w.clientA.onboardingId]));
    expect(onb!.template_version).toBe(1);

    const fresh = await withTenant(w.ctx.staff, (tx) =>
      createOnboardingFromTemplate(tx, { workspaceId: w.workspaceId, clientId: w.clientB.id, templateId: w.templateId, ownerUserId: w.staffId }),
    );
    expect(fresh.templateVersion).toBe(2);
    const items = await withSysTx((tx) => tx.q<{ item_key: string; title: string }>("select item_key, title from onboarding_items where onboarding_id = $1", [fresh.onboardingId]));
    expect(items.find((i) => i.item_key === "business_profile")?.title).toBe("Company profile (updated)");
    expect(items.some((i) => i.item_key === "w9")).toBe(true);
  });

  it("editing the draft without publishing does not affect new onboardings", async () => {
    const edited: TemplateContent = structuredClone(AGENCY_TEMPLATE.content);
    edited.sections[0].title = "Unpublished change";
    await withSysTx((tx) => tx.q("update templates set draft = $2 where id = $1", [w.templateId, JSON.stringify(edited)]));
    const fresh = await withTenant(w.ctx.staff, (tx) =>
      createOnboardingFromTemplate(tx, { workspaceId: w.workspaceId, clientId: w.clientA.id, templateId: w.templateId, ownerUserId: null }),
    );
    const titles = await withSysTx((tx) => tx.q<{ section_title: string }>("select distinct section_title from onboarding_items where onboarding_id = $1", [fresh.onboardingId]));
    expect(titles.map((t) => t.section_title)).not.toContain("Unpublished change");
  });

  it("published versions are immutable", async () => {
    await expect(withSysTx((tx) => tx.q("update template_versions set content = '{}' where template_id = $1", [w.templateId]))).rejects.toThrow(/immutable/);
  });

  it("unpublished templates can't start onboardings", async () => {
    const id = await withSysTx(async (tx) => (await tx.one<{ id: string }>("insert into templates (workspace_id, name) values ($1, 'Draft only') returning id", [w.workspaceId]))!.id);
    await expect(
      withTenant(w.ctx.staff, (tx) => createOnboardingFromTemplate(tx, { workspaceId: w.workspaceId, clientId: w.clientA.id, templateId: id, ownerUserId: null })),
    ).rejects.toThrow(/Publish the template/);
  });

  it("copies due dates, owners and dependencies into the onboarding", async () => {
    const rows = await withSysTx((tx) => tx.q<{ item_key: string; owner_user_id: string; depends_on: string[]; due_at: Date | null; audience: string; weight: number; critical: boolean }>(
      "select item_key, owner_user_id, depends_on, due_at, audience, weight, critical from onboarding_items where onboarding_id = $1",
      [w.clientA.onboardingId],
    ));
    const by = Object.fromEntries(rows.map((r) => [r.item_key, r]));
    const task = by.final_creative_review;
    expect(task.owner_user_id).toBe(w.staffId);
    expect(task.audience).toBe("internal");
    expect(task.depends_on).toEqual(["logo_files", "brand_guidelines", "creative_questionnaire"]);
    // "Due 2 days after its dependencies are approved": no date until then.
    expect(task.due_at).toBeNull();
    expect(by.business_profile.due_at).not.toBeNull();
    expect(by.access_google_ads.critical).toBe(true);
    expect(by.business_profile.weight).toBe(3);
  });

  it("an item due after its dependencies gets its date when the last one is approved", async () => {
    await withSysTx((tx) =>
      tx.q("update onboarding_items set status = 'approved' where onboarding_id = $1 and item_key in ('logo_files', 'brand_guidelines')", [w.clientA.onboardingId]),
    );
    expect((await itemDue(w.clientA.onboardingId, "final_creative_review"))).toBeNull();
    await withSysTx((tx) =>
      tx.q("update onboarding_items set status = 'approved' where onboarding_id = $1 and item_key = 'creative_questionnaire'", [w.clientA.onboardingId]),
    );
    const due = await itemDue(w.clientA.onboardingId, "final_creative_review");
    expect(due).not.toBeNull();
    expect(Math.round((due!.getTime() - Date.now()) / 86400000)).toBeGreaterThanOrEqual(1);
  });
});

async function itemDue(onboardingId: string, key: string) {
  return (await withSysTx((tx) => tx.one<{ due_at: Date | null }>("select due_at from onboarding_items where onboarding_id = $1 and item_key = $2", [onboardingId, key])))!.due_at;
}

describe("template validation", () => {
  it("accepts the built-in templates", () => {
    expect(validateTemplateContent(AGENCY_TEMPLATE.content).ok).toBe(true);
    expect(validateTemplateContent(ACCOUNTING_TEMPLATE.content).ok).toBe(true);
  });

  it("rejects fields that ask for passwords", () => {
    const c = structuredClone(AGENCY_TEMPLATE.content);
    c.sections[0].items[0].fields!.push({ key: "ga_password", label: "Google Analytics password", type: "text", required: true });
    const r = validateTemplateContent(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/password/i);
  });

  it("rejects unknown dependencies, cycles and duplicate keys", () => {
    const unknown = structuredClone(AGENCY_TEMPLATE.content);
    unknown.sections[0].items[0].dependsOn = ["missing_item"];
    expect(validateTemplateContent(unknown).ok).toBe(false);

    const cycle = structuredClone(AGENCY_TEMPLATE.content);
    cycle.sections[1].items[0].dependsOn = ["project_scope"]; // project_scope already depends on goals_audience
    expect(validateTemplateContent(cycle).ok).toBe(false);

    const dup = structuredClone(AGENCY_TEMPLATE.content);
    dup.sections[1].items[0].key = "business_profile";
    expect(validateTemplateContent(dup).ok).toBe(false);
  });

  it("requires tasks to be internal", () => {
    const c = structuredClone(AGENCY_TEMPLATE.content);
    const task = c.sections.flatMap((s) => s.items).find((i) => i.kind === "task")!;
    task.audience = "client";
    expect(validateTemplateContent(c).ok).toBe(false);
  });
});
