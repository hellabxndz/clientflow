import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page, type Browser } from "playwright";
import { pool } from "../src/lib/db";

/**
 * Browser smoke test against a running app with freshly seeded demo data (`npm run db:reset`).
 * Walks the product story end to end: the client finishes the last items from a phone, staff review them,
 * and the automation engine marks the client Ready for Kickoff and runs the handoff.
 */
const BASE = process.env.APP_URL ?? "http://localhost:3000";

async function login(browser: Browser, email: string, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
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
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];

async function main() {
  const johnson = (await q("select id from clients where name = 'Johnson Dental'")).id;
  const item = async (key: string, clientId = johnson) => (await q("select id from onboarding_items where client_id = $1 and item_key = $2", [clientId, key])).id;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  // 1. The client, on a phone, sees exactly what blocks kickoff.
  const client = await login(browser, "john@johnsondental.example.com", { width: 390, height: 844 });
  await expectText(client, "What's blocking kickoff");
  await expectText(client, "Google Ads access");
  step("client portal shows what is blocking kickoff");

  // 2. Grants Google Ads access with delegated access; a password is refused.
  await client.goto(`${BASE}/portal/items/${await item("access_google_ads")}`);
  await client.fill("#accountId", "482-193-5520");
  await client.check("input[name=confirmed]");
  await client.fill("#note", "our password is Hunter2!");
  await client.click("button[value=submit]");
  await expectText(client, "Please don't share passwords");
  step("password-like text is refused on an access request");
  await client.fill("#note", "Admin transfer from the old agency is done. Invite sent from john@.");
  await client.click("button[value=submit]");
  await client.waitForTimeout(1500);
  if ((await q("select status from onboarding_items where id = $1", [await item("access_google_ads")])).status !== "submitted")
    throw new Error("Google Ads access was not submitted");
  step("client confirms delegated access");

  // 3. Replaces the rejected logo with a vector file and resubmits.
  const logo = path.join(os.tmpdir(), "johnson-logo.svg");
  fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#0e7490"/></svg>');
  await client.goto(`${BASE}/portal/items/${await item("logo_files")}`);
  await expectText(client, /vector/i);
  await client.locator("input[type=file]").first().setInputFiles(logo);
  await client.locator("button", { hasText: /^Upload/ }).first().click();
  await expectText(client, "johnson-logo.svg");
  await client.click("button[value=submit]");
  await client.waitForTimeout(1500);
  const logoStatus = (await q("select status from onboarding_items where id = $1", [await item("logo_files")])).status;
  if (logoStatus !== "submitted") throw new Error(`logo not resubmitted (${logoStatus})`);
  step("client replaces the sent-back file and resubmits");

  // 4. Isolation: another client's item is a 404, and the staff app redirects.
  const acmeItem = await item("business_profile", (await q("select id from clients where name = 'Acme Fitness'")).id);
  const res = await client.goto(`${BASE}/portal/items/${acmeItem}`);
  if (res?.status() !== 404) throw new Error(`expected 404 for another client's item, got ${res?.status()}`);
  await client.goto(`${BASE}/app`);
  if (!client.url().includes("/portal")) throw new Error(`client reached staff app: ${client.url()}`);
  step("client cannot open another client's item or the staff workspace");

  // 5. The design lead approves the logo; the account manager approves the access.
  const priya = await login(browser, "priya@northstar.example.com");
  await priya.goto(`${BASE}/app/tasks?tab=review`);
  await expectText(priya, "Johnson Dental");
  await priya.goto(`${BASE}/app/clients/${johnson}/items/${await item("logo_files")}`);
  await priya.locator("button[name=decision][value=approve]").first().click();
  await priya.waitForTimeout(1500);
  if ((await q("select status from onboarding_items where id = $1", [await item("logo_files")])).status !== "approved") throw new Error("logo not approved");
  step("design lead approves the final logo from the review queue");

  const sarah = await login(browser, "sarah@northstar.example.com");
  await sarah.goto(`${BASE}/app/clients/${johnson}/items/${await item("access_google_ads")}`);
  await sarah.locator("button[name=decision][value=approve]").first().click();
  await sarah.waitForTimeout(2000);
  step("account manager approves Google Ads access");

  // 6. The engine marks Ready for Kickoff and runs the handoff (recorded, not sent, in the demo).
  const onb = await q("select id, kickoff_ready_at from onboardings where client_id = $1 and status = 'active'", [johnson]);
  if (!onb.kickoff_ready_at) throw new Error("Johnson Dental was not marked Ready for Kickoff");
  const handoff = await q(
    "select r.status, r.results from automation_runs r join automation_rules ar on ar.id = r.rule_id where ar.name = 'Kickoff handoff' and r.onboarding_id = $1",
    [onb.id],
  );
  if (!handoff) throw new Error("handoff rule did not run");
  const task = await q("select 1 as ok from onboarding_items where onboarding_id = $1 and title like 'Run kickoff call%'", [onb.id]);
  if (!task) throw new Error("kickoff task not created");
  const notified = await q(
    "select count(*)::int as n from notifications n join users u on u.id = n.user_id where u.email = 'sarah@northstar.example.com' and n.title like 'Johnson Dental is Ready for Kickoff%'",
  );
  if (notified.n !== 1) throw new Error("account manager was not notified exactly once");
  const sent = await q("select count(*)::int as n from email_messages where status = 'sent'");
  if (sent.n !== 0) throw new Error("demo workspace sent a real email");
  step("Ready for Kickoff: account manager and managers notified, kickoff task created, PM handoff recorded, no real email sent");

  await sarah.goto(`${BASE}/app`);
  await expectText(sarah, "Ready for Kickoff");
  await sarah.goto(`${BASE}/app/clients/${johnson}?tab=timeline`);
  await expectText(sarah, /Ready for Kickoff/);
  step("dashboard and client timeline show the change");

  // 7. Integrations are honest: nothing in the demo shows as connected.
  await sarah.goto(`${BASE}/app/integrations`);
  await expectText(sarah, "Not Connected");
  const connected = await sarah.getByText("Connected", { exact: true }).count();
  if (connected > 0) throw new Error("an integration claims to be connected in the demo");
  step("integrations hub shows honest states");

  await browser.close();
  await pool.end();
  console.log("All smoke checks passed.");
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
