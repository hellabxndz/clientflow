import "dotenv/config";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { pool } from "../src/lib/db";

/** Captures staff and client screens at desktop and mobile sizes and reports layout problems. */
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = process.argv[2] ?? "screenshots";

async function ids() {
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0];
  const bright = await q("select id from clients where name = 'Brightline Dental Group'");
  const summit = await q("select id from clients where name = 'Summit Outdoor Supply'");
  const access = await q("select id from onboarding_items where client_id = $1 and item_key = 'account_access'", [bright.id]);
  const logos = await q("select id from onboarding_items where client_id = $1 and item_key = 'logo_files'", [bright.id]);
  const goals = await q("select id from onboarding_items where client_id = $1 and item_key = 'goals_audience'", [bright.id]);
  const scope = await q("select id from onboarding_items where client_id = $1 and item_key = 'project_scope'", [bright.id]);
  const tpl = await q("select id from templates where name = 'Marketing agency onboarding'");
  return { bright: bright.id, summit: summit.id, access: access.id, logos: logos.id, goals: goals.id, scope: scope.id, tpl: tpl.id };
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
    ["staff", "reports", "/app/reports"],
    ["staff", "clients", "/app/clients"],
    ["staff", "client-brightline", `/app/clients/${id.bright}`],
    ["staff", "client-summit-ready", `/app/clients/${id.summit}`],
    ["staff", "item-access-review", `/app/clients/${id.bright}/items/${id.access}`],
    ["staff", "item-logo-files", `/app/clients/${id.bright}/items/${id.logos}`],
    ["staff", "new-client", "/app/clients/new"],
    ["staff", "templates", "/app/templates"],
    ["staff", "template-editor", `/app/templates/${id.tpl}`],
    ["staff", "tasks", "/app/tasks?who=all"],
    ["staff", "documents", "/app/documents"],
    ["staff", "settings-general", "/app/settings"],
    ["staff", "settings-team", "/app/settings/team"],
    ["staff", "settings-reminders", "/app/settings/reminders"],
    ["staff", "settings-email", "/app/settings/email"],
    ["staff", "settings-ai", "/app/settings/ai"],
    ["staff", "settings-security", "/app/settings/security"],
    ["staff", "settings-audit", "/app/settings/audit"],
    ["client", "portal-home", "/portal"],
    ["client", "portal-form", `/portal/items/${id.goals}`],
    ["client", "portal-access-checklist", `/portal/items/${id.access}`],
    ["client", "portal-files", `/portal/items/${id.logos}`],
    ["client", "portal-blocked", `/portal/items/${id.scope}`],
  ];
  for (const [vpName, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    for (const who of ["staff", "client"] as const) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: vpName === "mobile" ? 2 : 1 });
      const page = await ctx.newPage();
      page.on("console", (m) => m.type() === "error" && problems.push(`[${vpName}/${who}] console: ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${vpName}/${who}] pageerror: ${e.message}`));
      await login(page, who === "staff" ? "maya@northwind.example.com" : "marcus@brightline.example.com");
      for (const [role, name, path] of shots.filter((s) => s[0] === who)) {
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
