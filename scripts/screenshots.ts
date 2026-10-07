import "dotenv/config";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { pool } from "../src/lib/db";

/** Captures staff and client screens at desktop and mobile sizes and reports layout problems. */
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "screenshots";

async function ids() {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const client = async (name: string) => (await q("select id from clients where name = $1", [name])).id as string;
  const item = async (clientId: string, key: string) => (await q("select id from onboarding_items where client_id = $1 and item_key = $2", [clientId, key])).id as string;
  const johnson = await client("Johnson Dental");
  const acme = await client("Acme Fitness");
  const summit = await client("Summit Roofing");
  const brightline = await client("Brightline Legal");
  const tpl = (await q("select id from templates where name = 'Paid Ads Client'")).id;
  const rule = (await q("select id from automation_rules where name like 'Ready for Kickoff when ads%'")).id;
  return {
    johnson, acme, summit, brightline, tpl, rule,
    jLogo: await item(johnson, "logo_files"),
    jAds: await item(johnson, "access_google_ads"),
    jGoals: await item(johnson, "goals_audience"),
    jFinal: await item(johnson, "final_creative_review"),
    aLogo: await item(acme, "logo_files"),
  };
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", "demo-password-123");
  await Promise.all([page.waitForURL(/\/(app|portal)/), page.click("button[type=submit]")]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const id = await ids();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const problems: string[] = [];
  const shots: [string, string, string][] = [
    ["staff", "overview", "/app"],
    ["staff", "clients", "/app/clients"],
    ["staff", "clients-waiting-staff", "/app/clients?waiting=staff"],
    ["staff", "client-johnson", `/app/clients/${id.johnson}`],
    ["staff", "client-johnson-timeline", `/app/clients/${id.johnson}?tab=timeline`],
    ["staff", "client-summit-ready", `/app/clients/${id.summit}`],
    ["staff", "client-brightline-at-risk", `/app/clients/${id.brightline}`],
    ["staff", "item-johnson-logo", `/app/clients/${id.johnson}/items/${id.jLogo}`],
    ["staff", "item-acme-logo-review", `/app/clients/${id.acme}/items/${id.aLogo}`],
    ["staff", "new-client", "/app/clients/new"],
    ["staff", "review-queue", "/app/tasks?tab=review"],
    ["staff", "tasks", "/app/tasks?tab=tasks"],
    ["staff", "documents", "/app/documents"],
    ["staff", "templates", "/app/templates"],
    ["staff", "template-editor", `/app/templates/${id.tpl}`],
    ["staff", "automations", "/app/automations"],
    ["staff", "automation-rule", `/app/automations/${id.rule}`],
    ["staff", "automation-builder", `/app/automations/${id.rule}/edit`],
    ["staff", "automation-activity", "/app/automations/activity"],
    ["staff", "integrations", "/app/integrations"],
    ["staff", "reports", "/app/reports"],
    ["staff", "notifications", "/app/notifications"],
    ["staff", "settings-company", "/app/settings"],
    ["staff", "settings-branding", "/app/settings/branding"],
    ["staff", "settings-team", "/app/settings/team"],
    ["staff", "settings-client-types", "/app/settings/client-types"],
    ["staff", "settings-reminders", "/app/settings/reminders"],
    ["staff", "settings-email", "/app/settings/email"],
    ["staff", "settings-ai", "/app/settings/ai"],
    ["staff", "settings-security", "/app/settings/security"],
    ["staff", "settings-import", "/app/settings/import"],
    ["staff", "settings-audit", "/app/settings/audit"],
    ["staff", "settings-launch", "/app/settings/launch"],
    ["staff", "settings-pilot-readiness", "/app/settings/pilot-readiness"],
    ["client", "portal-home", "/portal"],
    ["client", "portal-form", `/portal/items/${id.jGoals}`],
    ["client", "portal-access", `/portal/items/${id.jAds}`],
    ["client", "portal-file-changes-requested", `/portal/items/${id.jLogo}`],
  ];
  for (const [vpName, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    for (const who of ["staff", "client"] as const) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: vpName === "mobile" ? 2 : 1 });
      const page = await ctx.newPage();
      let current = "login";
      page.on("console", (m) => m.type() === "error" && problems.push(`[${vpName}/${who}] ${current} console: ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${vpName}/${who}] ${current} pageerror: ${e.message}`));
      await login(page, who === "staff" ? "olivia@northstar.example.com" : "john@johnsondental.example.com");
      for (const [role, name, path] of shots.filter((s) => s[0] === who)) {
        current = name;
        const res = await page.goto(`${BASE}${path}`);
        if (!res || res.status() >= 400) problems.push(`[${vpName}] ${name}: HTTP ${res?.status()}`);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`[${vpName}] ${name}: horizontal overflow ${overflow}px`);
        await page.screenshot({ path: `${OUT}/${vpName}-${role}-${name}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  await browser.close();
  await pool.end();
  console.log(problems.length ? problems.join("\n") : "No layout or console problems found.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
