import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page, type Browser } from "playwright";
import { pool } from "../src/lib/db";

/**
 * Browser smoke test against a running app with freshly seeded demo data (`npm run db:reset`).
 * Exercises the main client and staff flows end to end.
 */
const BASE = process.env.APP_URL ?? "http://localhost:3000";

async function login(browser: Browser, email: string, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", "demo-password-123");
  await Promise.all([page.waitForURL(/\/(app|portal)/), page.click("button[type=submit]")]);
  return page;
}

async function expectText(page: Page, text: string | RegExp) {
  await page.getByText(text).first().waitFor({ timeout: 15000 });
}

const step = (name: string) => console.log(`✓ ${name}`);

async function main() {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const harbor = await q("select id from clients where name = 'Harbor & Pine Coffee'");
  const summit = await q("select id from clients where name = 'Summit Outdoor Supply'");
  const item = async (key: string) => (await q("select id from onboarding_items where client_id = $1 and item_key = $2", [harbor.id, key])).id;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // Client on a phone: fill and submit a form.
  const client = await login(browser, "elena@harborpine.example.com", { width: 390, height: 844 });
  await expectText(client, "Do this next");
  await client.goto(`${BASE}/portal/items/${await item("business_profile")}`);
  await client.fill("#f_legal_name", "Harbor & Pine Coffee LLC");
  await client.fill("#f_website", "https://harborpine.example.com");
  await client.selectOption("#f_industry", "Hospitality");
  await client.fill("#f_address", "12 Wharf St, Portland, OR");
  await client.click("button[value=submit]");
  await expectText(client, /billing email.*required/i);
  step("client sees validation errors for missing required fields");
  await client.fill("#f_billing_email", "billing@harborpine.example.com");
  await client.click("button[value=submit]");
  await expectText(client, "Submitted. The team will review it");
  step("client submits a form");

  // Client uploads a logo and submits.
  const logo = path.join(os.tmpdir(), "harbor-logo.svg");
  fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await client.goto(`${BASE}/portal/items/${await item("logo_files")}`);
  await client.setInputFiles("#file", logo);
  await client.getByRole("button", { name: "Upload" }).last().click();
  await expectText(client, "harbor-logo.svg");
  const bad = path.join(os.tmpdir(), "evil.exe");
  fs.writeFileSync(bad, "MZ");
  await client.setInputFiles("#file", bad);
  await client.getByRole("button", { name: "Upload" }).last().click();
  await expectText(client, ".exe files are not allowed");
  step("upload restrictions are enforced in the portal");
  await client.click("button[value=submit]");
  await expectText(client, "Submitted. The team will review it");
  step("client uploads a file and submits");

  // Client cannot open another client's item.
  const foreign = (await q("select i.id from onboarding_items i join clients c on c.id = i.client_id where c.name = 'Brightline Dental Group' and i.item_key = 'business_profile'")).id;
  const res = await client.goto(`${BASE}/portal/items/${foreign}`);
  if (res?.status() !== 404) throw new Error(`expected 404 for another client's item, got ${res?.status()}`);
  step("client gets 404 for another client's item");
  const staffPage = await client.goto(`${BASE}/app`);
  if (!client.url().endsWith("/portal")) throw new Error(`client reached staff app: ${client.url()} ${staffPage?.status()}`);
  step("client is redirected away from the staff workspace");

  // Staff reviews.
  const staff = await login(browser, "maya@northwind.example.com");
  await staff.goto(`${BASE}/app/clients/${harbor.id}/items/${await item("business_profile")}`);
  await expectText(staff, "Harbor & Pine Coffee LLC");
  await staff.getByRole("button", { name: "Approve", exact: true }).click();
  await expectText(staff, "Approved.");
  step("staff approves a submitted form");

  await staff.goto(`${BASE}/app/clients/${harbor.id}/items/${await item("logo_files")}`);
  const [download] = await Promise.all([staff.waitForEvent("download"), staff.getByRole("link", { name: "Download" }).first().click()]);
  if (!(await download.path())) throw new Error("download failed");
  step("staff downloads through a short-lived link");
  await staff.fill("textarea[name=note]", "Could you send a version with a transparent background?");
  await staff.getByRole("button", { name: "Request changes" }).last().click();
  await expectText(staff, "Changes requested. The client will see your note.");
  step("staff requests changes with a client-visible note");

  await client.goto(`${BASE}/portal`);
  await expectText(client, "Needs your attention");
  step("client portal shows the changes request first");

  // Internal note is not visible to the client.
  await staff.goto(`${BASE}/app/clients/${harbor.id}`);
  await staff.fill("textarea[name=body]", "Internal: client prefers calls before 10am");
  await staff.getByRole("button", { name: "Post" }).first().click();
  await expectText(staff, "Internal note saved.");
  await client.goto(`${BASE}/portal`);
  if ((await client.content()).includes("client prefers calls before 10am")) throw new Error("internal note leaked to client");
  step("internal notes stay hidden from the client");

  // Staff asks a question; client sees it.
  await staff.fill("textarea[name=question]", "Which of your two locations should we feature first?");
  await staff.getByRole("button", { name: "Add to client checklist" }).click();
  await expectText(staff, "Question sent");
  await client.goto(`${BASE}/portal`);
  await expectText(client, "Which of your two locations");
  step("staff questions appear in the client checklist");

  // Task dependency enforcement.
  await staff.goto(`${BASE}/app/clients/${harbor.id}/items/${await item("review_brief")}`);
  if (!(await staff.getByRole("button", { name: "Done" }).isDisabled())) throw new Error("blocked task could be completed");
  step("blocked tasks cannot be marked done");

  // AI assistant without credentials falls back to rules.
  await staff.goto(`${BASE}/app/clients/${harbor.id}`);
  await staff.getByRole("button", { name: "Summarize progress" }).click();
  await expectText(staff, "Rule-based result");
  await staff.getByRole("button", { name: "Draft reminder" }).click();
  await expectText(staff, /these items are still open/);
  step("assistant works without AI credentials");

  // Template edit + publish leaves existing onboardings on v1.
  const tpl = (await q("select id from templates where name = 'Marketing agency onboarding'")).id;
  await staff.goto(`${BASE}/app/templates/${tpl}`);
  await staff.fill("input[aria-label='Section title']", "Business details (v2)");
  await staff.fill("input[name=changeNote]", "Renamed section");
  await staff.getByRole("button", { name: "Publish v2" }).click();
  await expectText(staff, "Published.");
  const v = await q("select count(*)::int as n from onboarding_items where client_id = $1 and section_title = 'Business details (v2)'", [harbor.id]);
  if (v.n !== 0) throw new Error("template edit changed an existing onboarding");
  step("publishing a template doesn't change existing onboardings");

  // New client with invite, accepted in a fresh browser.
  await staff.goto(`${BASE}/app/clients/new`);
  await staff.fill("#name", "Riverbend Yoga Studio");
  await staff.fill("#contactName", "Ava Moreno");
  await staff.fill("#contactEmail", "ava@riverbend.example.com");
  await staff.getByRole("button", { name: "Create client" }).click();
  await expectText(staff, "Riverbend Yoga Studio was added.");
  const inviteUrl = await staff.inputValue("input[aria-label='Invitation link']");
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(inviteUrl);
  await fresh.fill("#name", "Ava Moreno");
  await fresh.fill("#password", "a-strong-password-1");
  await Promise.all([fresh.waitForURL(/\/portal/), fresh.click("button[type=submit]")]);
  await expectText(fresh, "Do this next");
  await fresh.goto(inviteUrl);
  await expectText(fresh, "already been used");
  step("new client invited, invitation accepted once, portal ready");

  // Reminder preview then enable.
  await staff.goto(`${BASE}/app/settings/reminders`);
  const card = staff.locator("section", { hasText: "Gentle check-in" });
  if (!(await card.getByRole("button", { name: "Enable" }).isDisabled())) throw new Error("rule enable allowed without preview");
  await card.getByRole("button", { name: "Preview" }).click();
  await expectText(staff, /Preview using/);
  await staff.reload();
  await staff.locator("section", { hasText: "Gentle check-in" }).getByRole("button", { name: "Enable" }).click();
  await staff.waitForTimeout(1000);
  await staff.reload();
  await staff.locator("section", { hasText: "Gentle check-in" }).getByText("On", { exact: true }).waitFor();
  step("reminders require a preview before enabling");
  await staff.getByRole("button", { name: "Run reminders now" }).click();
  await expectText(staff, /Done: 0 sent/);
  step("manual reminder run records demo emails without sending");

  // Completion approval.
  await staff.goto(`${BASE}/app/clients/${summit.id}`);
  staff.once("dialog", (d) => d.accept());
  await staff.getByRole("button", { name: "Approve completion" }).click();
  await expectText(staff, "Onboarding complete");
  step("authorized staff approve onboarding completion");

  // Staff without approval permission can't.
  const jordan = await login(browser, "jordan@northwind.example.com");
  await jordan.goto(`${BASE}/app/settings/team`);
  await expectText(jordan, "Only admins can invite team members.");
  step("non-admin staff can't manage the team");

  await browser.close();
  await pool.end();
  console.log("All smoke checks passed.");
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
