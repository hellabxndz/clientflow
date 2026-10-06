import "dotenv/config";
import crypto from "node:crypto";
import { pool, withSysTx, type Tx } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { createOnboardingFromTemplate, publishTemplate } from "../src/lib/templates";
import { ACCOUNTING_TEMPLATE, AGENCY_TEMPLATE } from "../src/lib/template-library";
import { getStorage } from "../src/lib/storage";
import { sha256 } from "../src/lib/tokens";

/**
 * Seeds a clearly labeled demo workspace with fictional clients at different onboarding stages.
 * All people, companies and emails are fictional (example.com). Demo workspaces never send email.
 */

export const DEMO_PASSWORD = "demo-password-123";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const svg = (text: string, color: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" rx="12" fill="${color}"/><text x="120" y="50" font-family="Helvetica" font-size="24" fill="#fff" text-anchor="middle">${text}</text></svg>`,
  );
const pdf = (title: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 72 700 Td (${title}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
  );

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

async function user(tx: Tx, email: string, name: string, password: string | null) {
  const row = await tx.one<{ id: string }>(
    `insert into users (email, name, password_hash) values ($1, $2, $3)
     on conflict (email) do update set name = excluded.name returning id`,
    [email, name, password ? await hashPassword(password) : null],
  );
  return row!.id;
}

async function setItem(
  tx: Tx,
  onboardingId: string,
  key: string,
  status: string,
  opts: { response?: unknown; daysAgo?: number; reviewer?: string } = {},
) {
  const when = daysAgo(opts.daysAgo ?? 1).toISOString();
  await tx.q(
    `update onboarding_items set status = $3, response = coalesce($4, response), updated_at = $5,
       submitted_at = case when $3 in ('submitted', 'approved', 'changes_requested') then $5::timestamptz - interval '6 hours' else submitted_at end,
       reviewed_at = case when $3 in ('approved', 'changes_requested') and audience = 'client' then $5::timestamptz else null end,
       reviewed_by = case when $3 in ('approved', 'changes_requested') and audience = 'client' then $6::uuid else null end
     where onboarding_id = $1 and item_key = $2`,
    [onboardingId, key, status, opts.response ? JSON.stringify(opts.response) : null, when, opts.reviewer ?? null],
  );
}

async function itemId(tx: Tx, onboardingId: string, key: string) {
  return (await tx.one<{ id: string }>("select id from onboarding_items where onboarding_id = $1 and item_key = $2", [onboardingId, key]))!.id;
}

async function addFile(
  tx: Tx,
  ws: string,
  clientId: string,
  onboardingId: string,
  key: string,
  name: string,
  data: Buffer,
  mime: string,
  uploader: string,
  review: "pending" | "approved" | "changes_requested" = "pending",
  reviewer?: string,
  note?: string,
) {
  const item = await itemId(tx, onboardingId, key);
  const doc = await tx.one<{ id: string }>(
    "insert into documents (workspace_id, client_id, onboarding_id, item_id, title) values ($1,$2,$3,$4,$5) returning id",
    [ws, clientId, onboardingId, item, name],
  );
  const storageKey = `${ws}/${clientId}/${crypto.randomUUID()}`;
  await getStorage().put(storageKey, data);
  await tx.q(
    `insert into document_versions (workspace_id, client_id, document_id, version, storage_key, original_name, mime_type, size_bytes,
       sha256, scan_status, scan_detail, review_status, review_note, reviewed_by, reviewed_at, uploaded_by, created_at)
     values ($1,$2,$3,1,$4,$5,$6,$7,$8,'not_scanned','No malware scanner configured',$9,$10,$11,$12,$13, now() - interval '2 days')`,
    [ws, clientId, doc!.id, storageKey, name, mime, data.length, sha256(data), review, note ?? null, reviewer ?? null, review === "pending" ? null : daysAgo(1), uploader],
  );
}

async function comment(tx: Tx, ws: string, clientId: string, onboardingId: string, key: string | null, author: string, visibility: "client" | "internal", body: string, ago = 1) {
  await tx.q(
    `insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ws, clientId, onboardingId, key ? await itemId(tx, onboardingId, key) : null, author, visibility, body, daysAgo(ago)],
  );
}

async function auditEv(tx: Tx, ws: string, actor: string | null, action: string, entityId: string | null, summary: string, ago = 1) {
  await tx.q(
    "insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, created_at) values ($1,$2,$3,'item',$4,$5,$6)",
    [ws, actor, action, entityId, summary, daysAgo(ago)],
  );
}

export async function seed() {
  await withSysTx(async (tx) => {
    const existing = await tx.one("select 1 from workspaces where slug = 'northwind-demo'");
    if (existing) {
      console.log("Demo data already present. Run `npm run db:reset` to recreate it.");
      return;
    }

    // ---- People ---------------------------------------------------------
    const maya = await user(tx, "maya@northwind.example.com", "Maya Chen", DEMO_PASSWORD);
    const jordan = await user(tx, "jordan@northwind.example.com", "Jordan Patel", DEMO_PASSWORD);
    const sam = await user(tx, "sam@northwind.example.com", "Sam Rivera", DEMO_PASSWORD);

    // ---- Workspace ------------------------------------------------------
    const ws = (await tx.one<{ id: string }>(
      `insert into workspaces (name, slug, is_demo, brand_color, portal_welcome, timezone, email_from_name, retention_days)
       values ('Northwind Creative (Demo)', 'northwind-demo', true, '#7647e8',
               'Welcome to Northwind Creative! Here is everything we need from you to kick off. You can save progress and come back anytime.',
               'America/New_York', 'Northwind Creative', 365) returning id`,
    ))!.id;
    await tx.q("insert into memberships (workspace_id, user_id, role, can_approve) values ($1,$2,'admin',true),($1,$3,'staff',false),($1,$4,'staff',true)", [
      ws,
      maya,
      jordan,
      sam,
    ]);

    // ---- Templates ------------------------------------------------------
    const agency = (await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [ws, AGENCY_TEMPLATE.name, AGENCY_TEMPLATE.description, AGENCY_TEMPLATE.category, JSON.stringify(AGENCY_TEMPLATE.content), maya],
    ))!.id;
    await publishTemplate(tx, agency, maya, "Initial version");
    const acct = (await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [ws, ACCOUNTING_TEMPLATE.name, ACCOUNTING_TEMPLATE.description, ACCOUNTING_TEMPLATE.category, JSON.stringify(ACCOUNTING_TEMPLATE.content), maya],
    ))!.id;
    await publishTemplate(tx, acct, maya, "Starter example");

    // ---- Clients --------------------------------------------------------
    async function client(name: string, industry: string, website: string, tz: string, contactName: string, contactEmail: string, owner: string) {
      const id = (await tx.one<{ id: string }>(
        `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [ws, name, industry, website, tz, contactName, contactEmail, owner],
      ))!.id;
      const contact = await user(tx, contactEmail, contactName, DEMO_PASSWORD);
      await tx.q("insert into memberships (workspace_id, user_id, role, client_id) values ($1,$2,'client',$3)", [ws, contact, id]);
      return { id, contact };
    }

    const harbor = await client("Harbor & Pine Coffee", "Hospitality", "https://harborpine.example.com", "America/Los_Angeles", "Elena Ruiz", "elena@harborpine.example.com", jordan);
    const bright = await client("Brightline Dental Group", "Healthcare", "https://brightline.example.com", "America/Chicago", "Marcus Webb", "marcus@brightline.example.com", jordan);
    const summit = await client("Summit Outdoor Supply", "E-commerce", "https://summitoutdoor.example.com", "America/Denver", "Priya Nair", "priya@summitoutdoor.example.com", sam);
    const lumen = await client("Lumen Analytics", "SaaS", "https://lumen.example.com", "Europe/London", "Oliver Grant", "oliver@lumen.example.com", maya);
    const copper = await client("Copper Kettle Bakery", "Hospitality", "https://copperkettle.example.com", "America/New_York", "Hana Kim", "hana@copperkettle.example.com", sam);
    const verde = await client("Verde Home Services", "Professional services", "https://verdehome.example.com", "America/New_York", "Luis Ortega", "luis@verdehome.example.com", jordan);

    const start = (c: { id: string }, owner: string, ago: number) =>
      createOnboardingFromTemplate(tx, { workspaceId: ws, clientId: c.id, templateId: agency, ownerUserId: owner, startDate: daysAgo(ago) });
    const backdate = (id: string, ago: number) => tx.q("update onboardings set created_at = $2 where id = $1", [id, daysAgo(ago)]);

    // 1. Harbor & Pine: just started, waiting on client.
    const h = (await start(harbor, jordan, 2)).onboardingId;
    await backdate(h, 2);
    await setItem(tx, h, "business_profile", "in_progress", {
      response: { legal_name: "Harbor & Pine Coffee LLC", website: "https://harborpine.example.com", industry: "Hospitality" },
    });
    await comment(tx, ws, harbor.id, h, null, jordan, "client", "Welcome aboard, Elena! Start with the company profile and contacts. Both take about five minutes.", 2);

    // 2. Brightline Dental: mid-way, mixed states, one overdue, changes requested, review waiting.
    const b = (await start(bright, jordan, 9)).onboardingId;
    await backdate(b, 9);
    await setItem(tx, b, "business_profile", "approved", {
      daysAgo: 6,
      reviewer: jordan,
      response: {
        legal_name: "Brightline Dental Group PC",
        website: "https://brightline.example.com",
        industry: "Healthcare",
        team_size: "51-200",
        address: "410 Lakeview Ave, Suite 200\nChicago, IL 60614",
        billing_email: "accounts@brightline.example.com",
      },
    });
    await setItem(tx, b, "contacts", "approved", {
      daysAgo: 6,
      reviewer: jordan,
      response: { primary_name: "Marcus Webb", primary_email: "marcus@brightline.example.com", approver_name: "Dr. Alana Brooks", approver_email: "abrooks@brightline.example.com", channel: "Email" },
    });
    await setItem(tx, b, "goals_audience", "submitted", {
      daysAgo: 1,
      response: { primary_goal: "More new-patient bookings", kpis: "Bookings", audience: "Families within 10 miles of our three Chicago clinics", channels: ["Paid search", "SEO"] },
    });
    await setItem(tx, b, "logo_files", "submitted", { daysAgo: 1 });
    await addFile(tx, ws, bright.id, b, "logo_files", "brightline-logo.svg", svg("Brightline", "#0e7490"), "image/svg+xml", bright.contact);
    await addFile(tx, ws, bright.id, b, "logo_files", "brightline-logo-white.png", PNG, "image/png", bright.contact);
    await setItem(tx, b, "account_access", "changes_requested", {
      daysAgo: 2,
      reviewer: jordan,
      response: { checked: ["ga4", "search_console"], notes: { cms: "We use Wix. Can you just use my login?" } },
    });
    await comment(tx, ws, bright.id, b, "account_access", jordan, "client",
      "Thanks Marcus! Please don't share your own login. In Wix, go to Settings > Roles & Permissions > Invite people, and invite our team email as Website Manager. Then tick the CMS step here.", 2);
    await comment(tx, ws, bright.id, b, "account_access", jordan, "internal", "Client offered their personal Wix password over email. Declined and asked for a collaborator invite instead.", 2);
    await auditEv(tx, ws, jordan, "item.changes_requested", await itemId(tx, b, "account_access"), "Requested changes on Account access checklist", 2);
    await setItem(tx, b, "sow_signature", "submitted", { daysAgo: 3, response: { client_note: "Signed via the e-signature email on Monday." } });
    await comment(tx, ws, bright.id, b, "goals_audience", jordan, "internal", "KPIs answer is thin. Ask for current monthly bookings baseline on the kickoff call.", 1);

    // 3. Summit Outdoor: all required items approved -> ready to start.
    const s = (await start(summit, sam, 15)).onboardingId;
    await backdate(s, 15);
    for (const key of ["business_profile", "goals_audience", "contacts", "project_scope", "logo_files", "account_access", "sow_signature", "kickoff_prefs"]) {
      await setItem(tx, s, key, "approved", { daysAgo: 4, reviewer: sam });
    }
    await tx.q(
      `update onboarding_items set response = $2 where onboarding_id = $1 and item_key = 'business_profile'`,
      [s, JSON.stringify({ legal_name: "Summit Outdoor Supply Inc.", website: "https://summitoutdoor.example.com", industry: "E-commerce", address: "88 Ridge Rd, Boulder, CO", billing_email: "ap@summitoutdoor.example.com" })],
    );
    await tx.q(
      `update onboarding_items set response = $2 where onboarding_id = $1 and item_key = 'account_access'`,
      [s, JSON.stringify({ checked: ["ga4", "google_ads", "meta", "search_console", "cms"] })],
    );
    await addFile(tx, ws, summit.id, s, "logo_files", "summit-logo.svg", svg("Summit", "#166534"), "image/svg+xml", summit.contact, "approved", sam);
    await addFile(tx, ws, summit.id, s, "brand_guidelines", "summit-brand-book.pdf", pdf("Summit Outdoor Brand Book"), "application/pdf", summit.contact, "approved", sam);
    await setItem(tx, s, "brand_guidelines", "approved", { daysAgo: 4, reviewer: sam });
    for (const key of ["verify_access", "review_brief", "schedule_kickoff"]) await setItem(tx, s, key, "approved", { daysAgo: 2 });
    await comment(tx, ws, summit.id, s, null, sam, "internal", "Kickoff booked for Thursday. Ready for completion sign-off.", 1);

    // 4. Lumen: paused.
    const l = (await start(lumen, maya, 20)).onboardingId;
    await backdate(l, 20);
    await setItem(tx, l, "business_profile", "approved", { daysAgo: 16, reviewer: maya });
    await setItem(tx, l, "contacts", "approved", { daysAgo: 16, reviewer: maya });
    await setItem(tx, l, "goals_audience", "in_progress", { daysAgo: 14 });
    await tx.q("update onboardings set status = 'paused', paused_at = $2 where id = $1", [l, daysAgo(12)]);
    await comment(tx, ws, lumen.id, l, null, maya, "internal", "Paused at client's request while their Q3 budget is re-approved. Reminders are stopped.", 12);

    // 5 + 6. Completed onboardings (real records for duration metrics).
    for (const [c, owner, startedAgo, finishedAgo] of [
      [copper, sam, 40, 27],
      [verde, jordan, 62, 44],
    ] as const) {
      const o = (await start(c, owner, startedAgo)).onboardingId;
      await backdate(o, startedAgo);
      await tx.q(
        `update onboarding_items set status = 'approved', submitted_at = $2::timestamptz - interval '2 days', reviewed_at = $2, updated_at = $2
         where onboarding_id = $1`,
        [o, daysAgo(finishedAgo + 1)],
      );
      await tx.q("update onboardings set status = 'completed', completed_at = $2, completed_by = $3, completion_note = 'All required items accepted.' where id = $1", [
        o,
        daysAgo(finishedAgo),
        maya,
      ]);
    }

    // ---- Reminder rules ---------------------------------------------------
    await tx.q(
      `insert into reminder_rules (workspace_id, name, trigger, offset_days, repeat_every_days, send_hour, subject, body, enabled, previewed_at) values
       ($1, 'Due soon', 'before_due', 2, null, 9, 'Coming up: a few onboarding items for {{client_name}}',
        E'Hi {{contact_name}},\n\nA quick heads-up that these items are due soon:\n\n{{item_list}}\n\nYou can pick up where you left off here: {{portal_link}}\n\nThanks!\n{{workspace_name}}', true, now()),
       ($1, 'Overdue nudge', 'overdue', 1, 3, 10, 'Still needed: onboarding items for {{client_name}}',
        E'Hi {{contact_name}},\n\nWe''re still waiting on a few items before we can start:\n\n{{item_list}}\n\nIf something is blocking you, just reply and we''ll help.\n{{portal_link}}\n\nThank you,\n{{workspace_name}}', true, now()),
       ($1, 'Gentle check-in', 'no_activity', 5, 7, 9, 'Checking in on your onboarding',
        E'Hi {{contact_name}},\n\nJust checking in. These items haven''t moved in a few days:\n\n{{item_list}}\n\n{{portal_link}}\n\n{{workspace_name}}', false, null)`,
      [ws],
    );
    await tx.q(
      `insert into email_messages (workspace_id, kind, to_email, subject, body, status, provider, sent_at, created_at)
       values ($1, 'invitation', 'elena@harborpine.example.com', 'You''re invited to Northwind Creative''s client portal', 'Demo invitation (simulated).', 'simulated', 'demo-outbox', $2, $2)`,
      [ws, daysAgo(2)],
    );
    await auditEv(tx, ws, maya, "workspace.created", null, "Demo workspace created", 70);

    // ---- Second workspace (isolation demo) --------------------------------
    const ws2 = (await tx.one<{ id: string }>(
      `insert into workspaces (name, slug, is_demo, brand_color, timezone) values ('Ledgerline Accounting (Demo)', 'ledgerline-demo', true, '#4f46e5', 'America/New_York') returning id`,
    ))!.id;
    const nora = await user(tx, "nora@ledgerline.example.com", "Nora Ellis", DEMO_PASSWORD);
    await tx.q("insert into memberships (workspace_id, user_id, role, can_approve) values ($1,$2,'admin',true),($1,$3,'staff',false)", [ws2, nora, maya]);
    const t2 = (await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [ws2, "Bookkeeping client onboarding", ACCOUNTING_TEMPLATE.description, "accounting", JSON.stringify(ACCOUNTING_TEMPLATE.content), nora],
    ))!.id;
    await publishTemplate(tx, t2, nora, "Initial version");
    const fern = (await tx.one<{ id: string }>(
      `insert into clients (workspace_id, name, industry, timezone, primary_contact_name, primary_contact_email, owner_user_id)
       values ($1, 'Fernwood Landscaping', 'Home services', 'America/New_York', 'Grace Lee', 'grace@fernwood.example.com', $2) returning id`,
      [ws2, nora],
    ))!.id;
    await createOnboardingFromTemplate(tx, { workspaceId: ws2, clientId: fern, templateId: t2, ownerUserId: nora, startDate: daysAgo(3) });
  });
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(() => {
      console.log(`Seeded demo data. Sign in as maya@northwind.example.com / ${DEMO_PASSWORD}`);
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
