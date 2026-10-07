import "dotenv/config";
import crypto from "node:crypto";
import { pool, withSysTx, withTenant, type Tx } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { createOnboardingFromTemplate, publishTemplate, type TemplateContent } from "../src/lib/templates";
import {
  ACCOUNTING_TEMPLATE,
  FULL_SERVICE_TEMPLATE,
  PAID_ADS_TEMPLATE,
  SEO_TEMPLATE,
  SOCIAL_TEMPLATE,
  WEBSITE_TEMPLATE,
  type LibraryTemplate,
} from "../src/lib/template-library";
import { getStorage } from "../src/lib/storage";
import { sha256 } from "../src/lib/tokens";
import { DEFAULT_REMINDER_BODY, renderReminder } from "../src/lib/reminders";
import { processPendingEvents, runTimeTriggers } from "../src/lib/automation/engine";
import { importClosedWonDeal } from "../src/lib/integrations/crm";
import { computeOnboardingState } from "../src/lib/onboarding";

/**
 * Seeds "Northstar Growth Agency (Demo)": a fictional marketing agency with clients at every onboarding stage,
 * real item history, documents, comments and reminders, plus a second workspace for isolation checks.
 *
 * Fixtures are written directly with backdated timestamps. The last part of the seed then runs the real
 * automation engine (CRM import, Ready for Kickoff, handoff, escalations), so the automation log, notifications
 * and recorded emails come from real runs. Demo workspaces never send email or call external services.
 * All people, companies and emails are fictional (example.com).
 */

export const DEMO_PASSWORD = "demo-password-123";

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);
const ahead = (days: number) => new Date(NOW + days * DAY);
/** A due date at 17:00 UTC, matching how template due dates are set. */
const dueOn = (offsetDays: number) => {
  const d = new Date(NOW + offsetDays * DAY);
  d.setUTCHours(17, 0, 0, 0);
  return d;
};
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Deterministic random numbers so the demo looks the same on every reseed. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261007);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const svg = (text: string, color: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96"><rect width="320" height="96" rx="14" fill="${color}"/><text x="160" y="58" font-family="Helvetica" font-size="26" fill="#fff" text-anchor="middle">${text}</text></svg>`,
  );
const pdf = (title: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 72 700 Td (${title}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
  );

let passwordHash: string;

async function user(tx: Tx, email: string, name: string, withPassword = true) {
  const row = await tx.one<{ id: string }>(
    `insert into users (email, name, password_hash) values ($1, $2, $3)
     on conflict (email) do update set name = excluded.name returning id`,
    [email, name, withPassword ? passwordHash : null],
  );
  return row!.id;
}

/** Library template with the brand files routed to a named reviewer. */
function withBrandReviewer(t: LibraryTemplate, reviewerId: string): TemplateContent {
  const content = structuredClone(t.content) as TemplateContent;
  for (const s of content.sections)
    for (const item of s.items)
      if (["logo_files", "brand_guidelines", "photos_videos", "existing_creative", "creative_questionnaire"].includes(item.key))
        item.review = { required: true, reviewer: { type: "user", userId: reviewerId } };
  return content;
}

async function addTemplate(tx: Tx, ws: string, t: LibraryTemplate, content: TemplateContent, by: string, note: string) {
  const id = (await tx.one<{ id: string }>(
    "insert into templates (workspace_id, name, description, category, draft, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [ws, t.name, t.description, t.category, JSON.stringify(content), by, ago(130)],
  ))!.id;
  await publishTemplate(tx, id, by, note);
  return id;
}

/** Helper bound to one onboarding for writing backdated fixture state. */
class Onb {
  constructor(
    readonly tx: Tx,
    readonly ws: string,
    readonly clientId: string,
    readonly id: string,
    readonly contactId: string | null,
  ) {}

  async itemId(key: string) {
    const row = await this.tx.one<{ id: string }>("select id from onboarding_items where onboarding_id = $1 and item_key = $2", [this.id, key]);
    if (!row) throw new Error(`No item ${key} in onboarding ${this.id}`);
    return row.id;
  }

  /**
   * Sets an item's state as of `at`. For client items, `submittedAt` defaults to 20 hours before a review.
   * `by` is the reviewer (client items) or the person who completed the task (internal items).
   */
  async set(key: string, status: string, o: { at: Date; by?: string | null; response?: unknown; submittedAt?: Date }) {
    const reviewed = status === "approved" || status === "changes_requested";
    const submittedAt =
      o.submittedAt ?? (reviewed ? new Date(o.at.getTime() - 20 * 3600_000) : ["submitted", "under_review"].includes(status) ? o.at : null);
    const id = await this.itemId(key);
    await this.tx.q(
      `update onboarding_items set status = $2::text, response = coalesce($3::jsonb, response), updated_at = $4::timestamptz,
         submitted_at = case when audience = 'client' then $5::timestamptz else null end,
         reviewed_at = case when $6::boolean then $4::timestamptz else null end,
         reviewed_by = case when $6::boolean then $7::uuid else null end
       where id = $1`,
      [id, status, o.response === undefined ? null : JSON.stringify(o.response), o.at, submittedAt, reviewed, o.by ?? null],
    );
    // The guard trigger stamps status_changed_at with now(); backdate it separately.
    await this.tx.q("update onboarding_items set status_changed_at = $2 where id = $1", [id, o.at]);
    return id;
  }

  async approveAll(keys: string[], at: (i: number) => Date, by: string, responses: Record<string, unknown> = {}) {
    for (const [i, key] of keys.entries()) await this.set(key, "approved", { at: at(i), by, response: responses[key] });
  }

  async due(key: string, at: Date | null) {
    await this.tx.q("update onboarding_items set due_at = $3 where onboarding_id = $1 and item_key = $2", [this.id, key, at]);
  }

  async file(
    key: string,
    name: string,
    data: Buffer,
    mime: string,
    o: { at: Date; review?: "pending" | "approved" | "changes_requested" | "rejected"; reviewer?: string; reviewedAt?: Date; note?: string; category?: string },
  ) {
    const item = await this.itemId(key);
    const doc = await this.tx.one<{ id: string }>(
      "insert into documents (workspace_id, client_id, onboarding_id, item_id, title, category, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [this.ws, this.clientId, this.id, item, name, o.category ?? "brand", o.at],
    );
    const storageKey = `${this.ws}/${this.clientId}/${crypto.randomUUID()}`;
    await getStorage().put(storageKey, data);
    const review = o.review ?? "pending";
    await this.tx.q(
      `insert into document_versions (workspace_id, client_id, document_id, version, storage_key, original_name, mime_type, size_bytes,
         sha256, scan_status, scan_detail, review_status, review_note, reviewed_by, reviewed_at, uploaded_by, created_at)
       values ($1,$2,$3,1,$4,$5,$6,$7,$8,'not_scanned','File scanning integration not configured',$9,$10,$11,$12,$13,$14)`,
      [
        this.ws,
        this.clientId,
        doc!.id,
        storageKey,
        name,
        mime,
        data.length,
        sha256(data),
        review,
        o.note ?? null,
        review === "pending" ? null : o.reviewer ?? null,
        review === "pending" ? null : o.reviewedAt ?? o.at,
        this.contactId,
        o.at,
      ],
    );
  }

  async comment(key: string | null, author: string | null, visibility: "client" | "internal", body: string, at: Date) {
    await this.tx.q(
      `insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.ws, this.clientId, this.id, key ? await this.itemId(key) : null, author, visibility, body, at],
    );
  }
}

/** Access-request answers never contain credentials: only account IDs and confirmation that an invite was sent. */
const granted = (accountId?: string, note?: string) => ({ confirmed: true, ...(accountId ? { accountId } : {}), ...(note ? { note } : {}) });

const businessProfile = (name: string, website: string, industry: string, services: string, locations: string, description: string) => ({
  business_name: name,
  website,
  industry,
  services,
  locations,
  description,
});

export async function seed() {
  passwordHash = await hashPassword(DEMO_PASSWORD);
  let demoWorkspaceId = "";
  let summitOnboarding = "";
  let michaelId = "";

  await withSysTx(async (tx) => {
    if (await tx.one("select 1 from workspaces where slug = 'northstar-demo'")) {
      console.log("Demo data already present. Run `npm run db:reset` to recreate it.");
      return;
    }

    // ---- People -----------------------------------------------------------
    const olivia = await user(tx, "olivia@northstar.example.com", "Olivia Bennett");
    const marcus = await user(tx, "marcus@northstar.example.com", "Marcus Reed");
    const sarah = await user(tx, "sarah@northstar.example.com", "Sarah Kim");
    const michael = await user(tx, "michael@northstar.example.com", "Michael Torres");
    const priya = await user(tx, "priya@northstar.example.com", "Priya Shah");
    michaelId = michael;

    // ---- Workspace --------------------------------------------------------
    const ws = (await tx.one<{ id: string }>(
      `insert into workspaces (name, slug, is_demo, brand_color, accent_color, portal_name, portal_welcome, timezone, email_from_name,
         support_email, support_phone, retention_days, launched_at, kickoff_lead_days, created_at, launch_checklist)
       values ('Northstar Growth Agency (Demo)', 'northstar-demo', true, '#6d28d9', '#a78bfa', 'Northstar Client Hub',
         'Welcome to Northstar! This is everything we need to launch your campaigns. Save as you go, and reach out to your account manager with any questions.',
         'America/New_York', 'Northstar Growth Agency', 'success@northstar.example.com', '+1 (555) 010-2040', 730, $1, 3, $2, $3)
       returning id`,
      [
        ago(120),
        ago(140),
        JSON.stringify({
          test_onboarding: { done: true, at: ago(124).toISOString(), by: olivia },
          security_review: { done: true, at: ago(121).toISOString(), by: olivia },
        }),
      ],
    ))!.id;
    demoWorkspaceId = ws;
    await tx.q(
      `insert into memberships (workspace_id, user_id, role, can_approve, created_at) values
       ($1,$2,'admin',true,$7),($1,$3,'manager',true,$7),($1,$4,'staff',true,$7),($1,$5,'staff',true,$7),($1,$6,'staff',true,$7)`,
      [ws, olivia, marcus, sarah, michael, priya, ago(138)],
    );

    // ---- Workflow templates and service lines ------------------------------
    const tpl: Record<string, string> = {};
    for (const t of [PAID_ADS_TEMPLATE, SEO_TEMPLATE, WEBSITE_TEMPLATE, FULL_SERVICE_TEMPLATE, SOCIAL_TEMPLATE])
      tpl[t.name] = await addTemplate(tx, ws, t, withBrandReviewer(t, priya), olivia, "Initial version");

    const types: Record<string, string> = {};
    for (const [i, [name, template, owner, description]] of (
      [
        ["Paid Ads", PAID_ADS_TEMPLATE, sarah, "Google Ads and Meta campaigns"],
        ["SEO", SEO_TEMPLATE, michael, "Technical and local SEO"],
        ["Website", WEBSITE_TEMPLATE, sarah, "Website design and build"],
        ["Full-Service", FULL_SERVICE_TEMPLATE, sarah, "Paid ads, SEO, website and creative"],
        ["Social Media", SOCIAL_TEMPLATE, michael, "Organic social and community management"],
      ] as const
    ).entries()) {
      types[name] = (await tx.one<{ id: string }>(
        "insert into client_types (workspace_id, name, description, template_id, default_owner_user_id, position) values ($1,$2,$3,$4,$5,$6) returning id",
        [ws, name, description, tpl[template.name], owner, i],
      ))!.id;
    }

    // ---- Clients ----------------------------------------------------------
    async function client(c: {
      name: string;
      type: string;
      industry: string;
      website: string;
      tz: string;
      contact: [string, string];
      owner: string;
      deal: number;
      recurrence: "one_time" | "monthly" | "annual";
      source?: string;
      createdAgo: number;
      portal?: boolean;
      extra?: [string, string, string][];
    }) {
      const id = (await tx.one<{ id: string }>(
        `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id,
           client_type_id, deal_amount, deal_recurrence, source, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [ws, c.name, c.industry, c.website, c.tz, c.contact[0], c.contact[1], c.owner, types[c.type], c.deal, c.recurrence, c.source ?? "manual", ago(c.createdAgo)],
      ))!.id;
      await tx.q("insert into client_contacts (workspace_id, client_id, name, email, contact_role, created_at) values ($1,$2,$3,$4,'primary',$5)", [
        ws,
        id,
        c.contact[0],
        c.contact[1],
        ago(c.createdAgo),
      ]);
      for (const [name, email, role] of c.extra ?? [])
        await tx.q("insert into client_contacts (workspace_id, client_id, name, email, contact_role, created_at) values ($1,$2,$3,$4,$5,$6)", [
          ws,
          id,
          name,
          email,
          role,
          ago(c.createdAgo),
        ]);
      let contact: string | null = null;
      if (c.portal !== false) {
        contact = await user(tx, c.contact[1], c.contact[0]);
        await tx.q("insert into memberships (workspace_id, user_id, role, client_id, created_at) values ($1,$2,'client',$3,$4)", [ws, contact, id, ago(c.createdAgo)]);
      }
      return { id, contact, type: c.type, owner: c.owner, name: c.name };
    }

    async function start(c: Awaited<ReturnType<typeof client>>, startedAgo: number, source = "manual") {
      const typeTemplate = { "Paid Ads": PAID_ADS_TEMPLATE, SEO: SEO_TEMPLATE, Website: WEBSITE_TEMPLATE, "Full-Service": FULL_SERVICE_TEMPLATE, "Social Media": SOCIAL_TEMPLATE }[c.type]!;
      const { onboardingId } = await createOnboardingFromTemplate(tx, {
        workspaceId: ws,
        clientId: c.id,
        templateId: tpl[typeTemplate.name],
        ownerUserId: c.owner,
        startDate: ago(startedAgo),
        source,
      });
      await tx.q("update onboardings set created_at = $2 where id = $1", [onboardingId, ago(startedAgo)]);
      await tx.q("update onboarding_items set created_at = $2, updated_at = $2 where onboarding_id = $1", [onboardingId, ago(startedAgo)]);
      return new Onb(tx, ws, c.id, onboardingId, c.contact);
    }

    // =========================================================================
    // 1. Johnson Dental (Paid Ads): waiting on Google Ads access and new logo files.
    // =========================================================================
    const johnson = await client({
      name: "Johnson Dental",
      type: "Paid Ads",
      industry: "Healthcare",
      website: "https://johnsondental.example.com",
      tz: "America/Chicago",
      contact: ["John Miller", "john@johnsondental.example.com"],
      owner: sarah,
      deal: 15000,
      recurrence: "monthly",
      source: "hubspot",
      createdAgo: 9,
      extra: [["Dr. Karen Johnson", "karen@johnsondental.example.com", "approver"]],
    });
    const jd = await start(johnson, 9, "hubspot");
    await jd.approveAll(
      ["business_profile", "contacts", "goals_audience", "project_scope", "brand_guidelines", "creative_questionnaire"],
      (i) => ago(7.5 - i * 0.6),
      sarah,
      {
        business_profile: businessProfile(
          "Johnson Family Dental PLLC",
          "https://johnsondental.example.com",
          "Healthcare",
          "General and cosmetic dentistry, Invisalign, emergency appointments",
          "Austin, Round Rock and Cedar Park, TX",
          "A family-owned practice with three clinics serving families in north Austin since 2004.",
        ),
        goals_audience: {
          primary_goal: "Book 60 new-patient appointments per month across the three clinics.",
          target_audience: "Families and young professionals within 10 miles of our clinics.",
          ideal_customer: "A parent booking checkups for the whole family, with dental insurance.",
          main_offer: "New-patient exam, cleaning and X-rays for $99.",
          lead_target: "60",
        },
        contacts: {
          primary_name: "John Miller",
          primary_email: "john@johnsondental.example.com",
          approver_name: "Dr. Karen Johnson",
          approver_email: "karen@johnsondental.example.com",
        },
      },
    );
    await jd.set("brand_guidelines", "approved", { at: ago(5.2), by: priya });
    await jd.set("creative_questionnaire", "approved", { at: ago(5.1), by: priya });
    await jd.file("brand_guidelines", "johnson-dental-brand-guide.pdf", pdf("Johnson Dental Brand Guide"), "application/pdf", {
      at: ago(6.2),
      review: "approved",
      reviewer: priya,
      reviewedAt: ago(5.2),
    });
    for (const [i, key] of ["access_meta_bm", "access_facebook_page", "access_instagram", "access_google_analytics", "access_google_tag_manager"].entries())
      await jd.set(key, "approved", { at: ago(4.8 - i * 0.3), by: sarah, response: granted(key === "access_meta_bm" ? "102938475610293" : undefined) });
    await jd.set("logo_files", "changes_requested", { at: ago(2.1), by: priya, submittedAt: ago(3) });
    await jd.file("logo_files", "johnson-logo-small.png", PNG, "image/png", {
      at: ago(3),
      review: "changes_requested",
      reviewer: priya,
      reviewedAt: ago(2.1),
      note: "This PNG is 120px wide. We need a vector file (SVG, AI, EPS or PDF) for ads and print.",
    });
    await jd.comment("logo_files", priya, "client", "Thanks John! This file is too small to use in ads. Could you ask your designer for the vector version (SVG, AI, EPS or PDF)?", ago(2.1));
    await jd.comment("logo_files", johnson.contact, "client", "Will do. Our designer is out until Thursday, I'll upload it as soon as I have it.", ago(1.8));
    await jd.set("access_google_ads", "in_progress", { at: ago(3.5), response: { accountId: "482-193-5520", confirmed: false } });
    await jd.due("access_google_ads", dueOn(-2));
    await jd.due("logo_files", dueOn(1));
    await jd.comment(
      "access_google_ads",
      johnson.contact,
      "client",
      "Our previous agency still owns the Google Ads account. We asked them to transfer admin access back to us so we can invite you.",
      ago(3.4),
    );
    await jd.comment("access_google_ads", sarah, "internal", "Followed up with John by phone. Old agency promised the transfer this week. Escalate to Marcus if it slips past Friday.", ago(1.2));
    await jd.set("kickoff_prefs", "approved", { at: ago(2.8), by: sarah, response: { preferred_days: ["Tuesday", "Thursday"], attendees: "John Miller, Dr. Karen Johnson" } });
    await jd.approveAll(["assign_owner", "kickoff_date"], (i) => ago(8.5 - i * 6), sarah);
    await tx.q("update onboardings set kickoff_date = $2 where id = $1", [jd.id, isoDate(ahead(5))]);

    // =========================================================================
    // 2. Acme Fitness (Social Media): client is done; brand files wait on Priya's review.
    // =========================================================================
    const acme = await client({
      name: "Acme Fitness",
      type: "Social Media",
      industry: "Fitness",
      website: "https://acmefitness.example.com",
      tz: "America/Denver",
      contact: ["Lena Brooks", "lena@acmefitness.example.com"],
      owner: michael,
      deal: 6500,
      recurrence: "monthly",
      createdAgo: 12,
    });
    const af = await start(acme, 12);
    await af.approveAll(
      ["business_profile", "contacts", "goals_audience", "project_scope", "creative_questionnaire", "kickoff_prefs"],
      (i) => ago(9 - i * 0.8),
      michael,
      {
        business_profile: businessProfile(
          "Acme Fitness Studios LLC",
          "https://acmefitness.example.com",
          "Fitness",
          "Group classes, personal training, memberships",
          "Denver and Boulder, CO",
          "Two boutique gyms focused on strength training for busy professionals.",
        ),
      },
    );
    await af.set("creative_questionnaire", "approved", { at: ago(4.5), by: priya });
    for (const [i, key] of ["access_meta_bm", "access_facebook_page", "access_instagram"].entries())
      await af.set(key, "approved", { at: ago(6 - i * 0.4), by: michael, response: granted(key === "access_meta_bm" ? "558812340912" : undefined) });
    await af.approveAll(["assign_owner", "verify_access", "kickoff_date"], (i) => [ago(11.5), ago(4.7), ago(3.9)][i], michael);
    for (const key of ["logo_files", "brand_guidelines", "photos_videos"]) await af.set(key, "submitted", { at: ago(2.2) });
    await af.file("logo_files", "acme-fitness-logo.svg", svg("ACME FITNESS", "#dc2626"), "image/svg+xml", { at: ago(2.2) });
    await af.file("brand_guidelines", "acme-brand-guidelines.pdf", pdf("Acme Fitness Brand Guidelines"), "application/pdf", { at: ago(2.2) });
    await af.file("photos_videos", "studio-photo-01.png", PNG, "image/png", { at: ago(2.2) });
    await af.comment(null, acme.contact, "client", "All brand files are uploaded. Let us know if anything else is needed!", ago(2.2));
    await tx.q("update onboardings set kickoff_date = $2 where id = $1", [af.id, isoDate(ahead(6))]);

    // =========================================================================
    // 3. Luxe Skin Studio (Full-Service): mid-way, two access requests overdue.
    // =========================================================================
    const luxe = await client({
      name: "Luxe Skin Studio",
      type: "Full-Service",
      industry: "Beauty and wellness",
      website: "https://luxeskin.example.com",
      tz: "America/Los_Angeles",
      contact: ["Ava Martinez", "ava@luxeskin.example.com"],
      owner: sarah,
      deal: 9000,
      recurrence: "monthly",
      createdAgo: 6,
    });
    const ls = await start(luxe, 6);
    await ls.approveAll(["business_profile", "contacts", "goals_audience", "logo_files", "brand_guidelines"], (i) => ago(4.6 - i * 0.4), sarah);
    await ls.set("logo_files", "approved", { at: ago(3.0), by: priya });
    await ls.set("brand_guidelines", "approved", { at: ago(2.9), by: priya });
    await ls.file("logo_files", "luxe-logo.svg", svg("LUXE", "#a16207"), "image/svg+xml", { at: ago(4), review: "approved", reviewer: priya, reviewedAt: ago(3) });
    await ls.file("brand_guidelines", "luxe-brand-book.pdf", pdf("Luxe Skin Studio Brand Book"), "application/pdf", {
      at: ago(3.9),
      review: "approved",
      reviewer: priya,
      reviewedAt: ago(2.9),
    });
    await ls.set("access_meta_bm", "approved", { at: ago(2.5), by: sarah, response: granted("771203948812") });
    await ls.set("access_facebook_page", "approved", { at: ago(2.4), by: sarah, response: granted() });
    await ls.set("access_instagram", "approved", { at: ago(2.4), by: sarah, response: granted() });
    await ls.set("creative_questionnaire", "submitted", { at: ago(0.8), response: { colors: "#1c1917, #d6b98c", tone: "Calm, clinical and luxurious. Never salesy." } });
    await ls.set("access_google_analytics", "submitted", { at: ago(0.7), response: granted("G-8K2L4M9Q1Z") });
    await ls.set("project_scope", "submitted", { at: ago(1.3) });
    await ls.set("kickoff_prefs", "in_progress", { at: ago(0.6), response: { preferred_days: ["Wednesday"] } });
    await ls.approveAll(["assign_owner"], () => ago(5.8), sarah);
    await ls.due("access_google_ads", dueOn(2));
    await ls.due("access_google_tag_manager", dueOn(-1));
    await ls.due("access_website_cms", dueOn(-2));
    await ls.comment("access_website_cms", luxe.contact, "client", "Our site is on Squarespace. Which permission level should I give you?", ago(1.1));
    await ls.comment("access_website_cms", sarah, "client", "Great question! Please invite web@northstar.example.com as an Administrator under Settings > Permissions. No password needed.", ago(1));

    // =========================================================================
    // 4. Summit Roofing (SEO): every client item approved. Final approval runs through the engine below.
    // =========================================================================
    const summit = await client({
      name: "Summit Roofing",
      type: "SEO",
      industry: "Home services",
      website: "https://summitroofing.example.com",
      tz: "America/Denver",
      contact: ["Tom Wallace", "tom@summitroofing.example.com"],
      owner: michael,
      deal: 3500,
      recurrence: "monthly",
      createdAgo: 14,
    });
    const sr = await start(summit, 14);
    summitOnboarding = sr.id;
    await sr.approveAll(
      ["business_profile", "contacts", "goals_audience", "project_scope", "kickoff_prefs"],
      (i) => ago(11 - i),
      michael,
      {
        business_profile: businessProfile(
          "Summit Roofing & Exteriors Inc.",
          "https://summitroofing.example.com",
          "Home services",
          "Roof repair and replacement, gutters, storm damage inspections",
          "Colorado Springs and Pueblo, CO",
          "A licensed roofing contractor with 40 crews across southern Colorado.",
        ),
      },
    );
    for (const [i, key] of ["access_google_analytics", "access_google_tag_manager", "access_search_console", "access_website_cms"].entries())
      await sr.set(key, "approved", { at: ago(5 - i * 0.5), by: michael, response: granted() });
    await sr.approveAll(["assign_owner", "verify_access", "kickoff_date"], (i) => [ago(13.5), ago(2.5), ago(1.6)][i], michael);
    await tx.q("update onboardings set kickoff_date = $2 where id = $1", [sr.id, isoDate(ahead(4))]);
    await sr.comment(null, michael, "internal", "All access verified. Final approval is the only step left.", ago(1.5));

    // =========================================================================
    // 5. Brightline Legal (Website): at risk. Inactive 11 days, overdue access and logo.
    // =========================================================================
    const brightline = await client({
      name: "Brightline Legal",
      type: "Website",
      industry: "Legal services",
      website: "https://brightlinelegal.example.com",
      tz: "America/New_York",
      contact: ["Rachel Adams", "rachel@brightlinelegal.example.com"],
      owner: sarah,
      deal: 24000,
      recurrence: "one_time",
      createdAgo: 22,
    });
    const bl = await start(brightline, 22);
    await bl.approveAll(["business_profile", "contacts", "goals_audience"], (i) => ago(18 - i), sarah);
    await bl.approveAll(["assign_owner"], () => ago(21.5), sarah);
    await bl.set("access_google_analytics", "approved", { at: ago(13), by: sarah, response: granted("G-BL55RT2026") });
    await bl.set("brand_guidelines", "approved", { at: ago(12.5), by: priya, submittedAt: ago(14) });
    await bl.set("creative_questionnaire", "approved", { at: ago(12.4), by: priya, submittedAt: ago(13.5) });
    await bl.file("brand_guidelines", "brightline-style-guide.pdf", pdf("Brightline Legal Style Guide"), "application/pdf", {
      at: ago(14),
      review: "approved",
      reviewer: priya,
      reviewedAt: ago(12.5),
    });
    await bl.set("project_scope", "under_review", { at: ago(3), submittedAt: ago(11) });
    for (const [key, days] of [
      ["logo_files", -8],
      ["access_website_cms", -8],
      ["access_domain_dns", -4],
      ["access_google_tag_manager", -4],
    ] as const)
      await bl.due(key, dueOn(days));
    await bl.comment(null, sarah, "client", "Hi Rachel, just checking in. We still need your logo files and website access to start the design phase.", ago(6));
    await bl.comment("project_scope", sarah, "internal", "Scope includes a client portal integration that wasn't in the proposal. Confirm with Marcus before approving.", ago(3));

    // =========================================================================
    // 6. Riverbend Plumbing (SEO): paused at the client's request.
    // =========================================================================
    const riverbend = await client({
      name: "Riverbend Plumbing",
      type: "SEO",
      industry: "Home services",
      website: "https://riverbendplumbing.example.com",
      tz: "America/Chicago",
      contact: ["Dana Price", "dana@riverbendplumbing.example.com"],
      owner: michael,
      deal: 2800,
      recurrence: "monthly",
      createdAgo: 30,
    });
    const rp = await start(riverbend, 30);
    await rp.approveAll(["business_profile", "contacts"], (i) => ago(26 - i), michael);
    await rp.approveAll(["assign_owner"], () => ago(29), michael);
    await rp.set("goals_audience", "in_progress", { at: ago(24) });
    await tx.q("update onboardings set status = 'paused', paused_at = $2 where id = $1", [rp.id, ago(12)]);
    await rp.comment(null, michael, "internal", "Paused at Dana's request while they finish a website migration. Reminders are stopped.", ago(12));

    // =========================================================================
    // Completed onboardings after launch (real records for reports and ROI).
    // =========================================================================
    const done = [
      ["Copper Kettle Bakery", "Social Media", "Hospitality", michael, 4200, 98, 16],
      ["Verde Home Services", "SEO", "Home services", michael, 3200, 84, 14],
      ["Oakridge Vet Clinic", "Paid Ads", "Veterinary", sarah, 7800, 66, 21],
      ["Bluewave Pools", "Full-Service", "Home services", sarah, 11500, 51, 19],
      ["Metro Movers", "Paid Ads", "Logistics", sarah, 6000, 37, 17],
    ] as const;
    for (const [name, type, industry, owner, deal, startedAgo, duration] of done) {
      const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
      const first = name.split(" ")[0];
      const c = await client({
        name,
        type,
        industry,
        website: `https://${slug}.example.com`,
        tz: "America/New_York",
        contact: [`${first} Contact`, `hello@${slug}.example.com`],
        owner,
        deal,
        recurrence: "monthly",
        createdAgo: startedAgo,
      });
      const o = await start(c, startedAgo);
      const finished = startedAgo - duration;
      const items = await tx.q<{ item_key: string; audience: string; kind: string }>(
        "select item_key, audience, kind from onboarding_items where onboarding_id = $1 order by position",
        [o.id],
      );
      for (const it of items) {
        // Access requests consistently arrive last; that pattern is what "most delayed requirements" reports.
        const frac =
          it.item_key === "final_approval"
            ? 0.99
            : it.kind === "access"
              ? 0.55 + rand() * 0.3
              : it.audience === "internal"
                ? 0.2 + rand() * 0.6
                : it.kind === "form"
                  ? 0.05 + rand() * 0.3
                  : 0.2 + rand() * 0.4;
        const submitted = startedAgo - duration * frac;
        const reviewed = Math.max(finished + 0.05, submitted - (0.2 + rand() * 1.6));
        await o.set(it.item_key, "approved", {
          at: ago(it.audience === "internal" ? submitted : reviewed),
          by: owner,
          submittedAt: it.audience === "client" ? ago(submitted) : undefined,
        });
      }
      await tx.q(
        `update onboardings set status = 'completed', completed_at = $2, completed_by = $3, completion_note = 'All required items approved. Handed off to delivery.',
           kickoff_ready_at = $4, kickoff_date = $5, handed_off_at = $4 where id = $1`,
        [o.id, ago(finished), marcus, ago(finished + 0.02), isoDate(ago(finished - 3))],
      );
    }

    // Completed onboardings before ClientFlow, imported from a spreadsheet (no item-level history).
    const historical = [
      ["Pine & Co Realty", "Paid Ads", 300, 41],
      ["Harbor Coffee Co", "Social Media", 270, 34],
      ["Sunset Yoga", "Social Media", 240, 38],
      ["Granite Law Group", "Website", 215, 46],
      ["Evergreen Dental", "Paid Ads", 190, 30],
      ["Cityline Auto", "SEO", 170, 44],
    ] as const;
    for (const [name, type, startedAgo, duration] of historical) {
      const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
      const c = await client({
        name,
        type,
        industry: "Local business",
        website: `https://${slug}.example.com`,
        tz: "America/New_York",
        contact: ["Office Manager", `office@${slug}.example.com`],
        owner: type === "SEO" || type === "Social Media" ? michael : sarah,
        deal: 3000 + Math.round(rand() * 6) * 1000,
        recurrence: "monthly",
        source: "import",
        createdAgo: startedAgo,
        portal: false,
      });
      const typeTemplate = { "Paid Ads": PAID_ADS_TEMPLATE, SEO: SEO_TEMPLATE, Website: WEBSITE_TEMPLATE, "Social Media": SOCIAL_TEMPLATE }[type]!;
      await tx.q(
        `insert into onboardings (workspace_id, client_id, template_id, template_name, name, status, start_date, completed_at, owner_user_id, source, created_at)
         values ($1,$2,$3,$4,$4,'completed',$5,$6,$7,'import',$8)`,
        [ws, c.id, tpl[typeTemplate.name], typeTemplate.name, isoDate(ago(startedAgo)), ago(startedAgo - duration), c.owner, ago(118)],
      );
    }
    const histHeader = ["client_name", "template", "start_date", "completed_date", "status"];
    const histRows = historical.map(([name, type, startedAgo, duration]) => [
      name,
      { "Paid Ads": PAID_ADS_TEMPLATE, SEO: SEO_TEMPLATE, Website: WEBSITE_TEMPLATE, "Social Media": SOCIAL_TEMPLATE }[type]!.name,
      isoDate(ago(startedAgo)),
      isoDate(ago(startedAgo - duration)),
      "completed",
    ]);
    await tx.q(
      `insert into imports (workspace_id, kind, filename, status, header, rows, mapping, summary, created_by, created_at, completed_at)
       values ($1, 'onboardings', 'past-onboardings-2025.csv', 'completed', $2, $3, $4, $5, $6, $7, $7)`,
      [
        ws,
        histHeader,
        JSON.stringify(histRows),
        JSON.stringify({ client: 0, template: 1, start_date: 2, completed_date: 3, status: 4 }),
        JSON.stringify({ created: historical.length, skippedDuplicates: 0, failed: 0, errors: [] }),
        olivia,
        ago(118),
      ],
    );

    // Paid Ads v2: published after the fixtures above, so Johnson Dental stays on v1 until someone upgrades it explicitly.
    const paidV2 = withBrandReviewer(PAID_ADS_TEMPLATE, priya);
    paidV2.sections.find((s) => s.key === "project")!.items.push({
      key: "call_tracking",
      kind: "question",
      title: "Call tracking preferences",
      description: "Should we set up call tracking numbers for your ads? If so, which locations?",
      audience: "client",
      required: false,
      dueOffsetDays: 7,
    });
    await tx.q("update templates set draft = $2 where id = $1", [tpl[PAID_ADS_TEMPLATE.name], JSON.stringify(paidV2)]);
    await publishTemplate(tx, tpl[PAID_ADS_TEMPLATE.name], olivia, "Added optional call tracking question");

    // ---- History, audit trail and activity ----------------------------------
    await rebuildHistory(tx, ws);
    await tx.q("update onboardings set last_client_activity_at = $2 where id = $1", [bl.id, ago(11)]);

    // ---- Reminder rules -----------------------------------------------------
    const rules = await tx.q<{ id: string; name: string }>(
      `insert into reminder_rules (workspace_id, name, trigger, offset_days, repeat_every_days, send_hour, subject, body, enabled, previewed_at,
         item_scope, notify_owner, business_days_only, created_at) values
       ($1, 'Upcoming deadline', 'before_due', 2, null, 9, 'Coming up: a few onboarding items for {{client_name}}',
        E'Hi {{contact_name}},\n\nA quick heads-up that these items are due soon:\n\n{{item_list}}\n\nYou can pick up where you left off here: {{portal_link}}\n\nThank you,\n{{workspace_name}}',
        true, $2, 'all', false, true, $2),
       ($1, 'Overdue items', 'overdue', 1, 3, 10, 'Your onboarding is almost complete', $3, true, $2, 'all', true, true, $2),
       ($1, 'Missing account access', 'no_activity', 4, 5, 10, 'Account access still needed for {{client_name}}',
        E'Hi {{contact_name}},\n\nWe still need access to these accounts:\n\n{{item_list}}\n\nEach request in your portal has step-by-step instructions to invite our team. We never need your password.\n{{portal_link}}\n\nThank you,\n{{workspace_name}}',
        true, $2, 'access', false, true, $2),
       ($1, 'Unanswered questions', 'no_activity', 3, 4, 9, 'A quick question from {{workspace_name}}',
        E'Hi {{contact_name}},\n\nWe have a question waiting for you:\n\n{{item_list}}\n\n{{portal_link}}\n\n{{workspace_name}}',
        false, null, 'question', false, true, $2)
       returning id, name`,
      [ws, ago(119), DEFAULT_REMINDER_BODY + "\n{{portal_link}}"],
    );
    const overdueRule = rules.find((r) => r.name === "Overdue items")!;

    // Reminder history: what the reminder job recorded on earlier days (demo workspaces record emails, never send them).
    const jdItems = await tx.q<{ id: string; title: string; due_at: Date | null; status: string; updated_at: Date }>(
      "select id, title, due_at, status, updated_at from onboarding_items where onboarding_id = $1 and item_key in ('access_google_ads', 'logo_files') order by position desc",
      [jd.id],
    );
    const jdMsg = renderReminder(
      { subject: "Your onboarding is almost complete", body: DEFAULT_REMINDER_BODY + "\n{{portal_link}}" },
      { contactName: "John", clientName: "Johnson Dental", workspaceName: "Northstar Growth Agency", items: jdItems, timeZone: "America/Chicago", accountManager: "Sarah Kim" },
    );
    await tx.q(
      `insert into email_messages (workspace_id, kind, rule_id, onboarding_id, item_ids, dedupe_key, to_email, subject, body, status, provider, sent_at, created_at)
       values ($1, 'reminder', $2, $3, $4, $5, 'john@johnsondental.example.com', $6, $7, 'simulated', 'demo-outbox', $8, $8)`,
      [ws, overdueRule.id, jd.id, jdItems.map((i) => i.id), `${overdueRule.id}:${jd.id}:john@johnsondental.example.com:${isoDate(ago(1))}`, jdMsg.subject, jdMsg.body, ago(1)],
    );
    const blItems = await tx.q<{ id: string; title: string; due_at: Date | null; status: string; updated_at: Date }>(
      "select id, title, due_at, status, updated_at from onboarding_items where onboarding_id = $1 and audience = 'client' and status = 'not_started' and required order by position",
      [bl.id],
    );
    for (const d of [7, 4, 1]) {
      const msg = renderReminder(
        { subject: "Your onboarding is almost complete", body: DEFAULT_REMINDER_BODY + "\n{{portal_link}}" },
        { contactName: "Rachel", clientName: "Brightline Legal", workspaceName: "Northstar Growth Agency", items: blItems, timeZone: "America/New_York" },
      );
      await tx.q(
        `insert into email_messages (workspace_id, kind, rule_id, onboarding_id, item_ids, dedupe_key, to_email, subject, body, status, provider, sent_at, created_at)
         values ($1, 'reminder', $2, $3, $4, $5, 'rachel@brightlinelegal.example.com', $6, $7, 'simulated', 'demo-outbox', $8, $8)`,
        [ws, overdueRule.id, bl.id, blItems.map((i) => i.id), `${overdueRule.id}:${bl.id}:rachel@brightlinelegal.example.com:${isoDate(ago(d))}`, msg.subject, msg.body, ago(d)],
      );
    }
    const lsItems = await tx.q<{ id: string; title: string; due_at: Date | null; status: string; updated_at: Date }>(
      "select id, title, due_at, status, updated_at from onboarding_items where onboarding_id = $1 and item_key = 'access_google_ads'",
      [ls.id],
    );
    const lsMsg = renderReminder(
      { subject: "Coming up: a few onboarding items for {{client_name}}", body: "Hi {{contact_name}},\n\nA quick heads-up that these items are due soon:\n\n{{item_list}}\n\nThank you,\n{{workspace_name}}" },
      { contactName: "Ava", clientName: "Luxe Skin Studio", workspaceName: "Northstar Growth Agency", items: lsItems, timeZone: "America/Los_Angeles" },
    );
    await tx.q(
      `insert into email_messages (workspace_id, kind, rule_id, onboarding_id, item_ids, to_email, subject, body, status, provider, send_after, status_reason, created_at)
       values ($1, 'reminder', $2, $3, $4, 'ava@luxeskin.example.com', $5, $6, 'scheduled', 'demo-outbox', $7, 'Waiting for the next send window', now())`,
      [ws, rules[0].id, ls.id, lsItems.map((i) => i.id), lsMsg.subject, lsMsg.body, ahead(1)],
    );

    // ---- Automation rules -----------------------------------------------------
    const rule = (r: {
      name: string;
      description: string;
      category?: "automation" | "escalation" | "handoff";
      trigger: string;
      triggerConfig?: Record<string, unknown>;
      conditions?: unknown[];
      conditionMode?: "all" | "any";
      actions: unknown[];
      runMode?: "once_per_onboarding" | "every_event";
      enabled?: boolean;
    }) =>
      tx.q(
        `insert into automation_rules (workspace_id, name, description, category, enabled, trigger, trigger_config, conditions, condition_mode, actions, run_mode, created_by, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [
          ws,
          r.name,
          r.description,
          r.category ?? "automation",
          r.enabled ?? true,
          r.trigger,
          JSON.stringify(r.triggerConfig ?? {}),
          JSON.stringify(r.conditions ?? []),
          r.conditionMode ?? "all",
          JSON.stringify(r.actions),
          r.runMode ?? "once_per_onboarding",
          olivia,
          ago(118),
        ],
      );

    await rule({
      name: "Closed-won deal starts onboarding",
      description: "When a CRM deal is won, create the onboarding from the service's workflow, assign the account manager and invite the client.",
      trigger: "deal_imported",
      runMode: "every_event",
      actions: [
        { type: "create_onboarding" },
        { type: "assign_owner", owner: "client_type_default" },
        { type: "invite_client" },
        { type: "create_task", title: "Send welcome email and intro video", assignee: "onboarding_owner", dueInDays: 1 },
        { type: "notify_staff", to: "onboarding_owner", message: "New client {{client_name}} signed. Their onboarding has started.", email: true },
        { type: "chat_notification", provider: "slack", message: ":tada: {{client_name}} signed! Onboarding started with {{owner_name}}." },
      ],
    });
    await rule({
      name: "Ready for Kickoff when ads access, brand and kickoff details are in",
      description: "Google Ads access approved AND brand assets approved AND kickoff questionnaire submitted.",
      trigger: "item_approved",
      conditions: [
        { type: "item_status", itemKey: "access_google_ads", state: "approved" },
        { type: "section_complete", sectionKey: "brand" },
        { type: "item_status", itemKey: "kickoff_prefs", state: "submitted" },
        { type: "not_ready_for_kickoff" },
      ],
      actions: [{ type: "mark_ready_for_kickoff" }],
    });
    await rule({
      name: "Ready for Kickoff when everything required is approved",
      description: "Marks the onboarding Ready for Kickoff as soon as every required item is approved.",
      trigger: "all_required_completed",
      conditions: [{ type: "not_ready_for_kickoff" }],
      actions: [{ type: "mark_ready_for_kickoff" }],
    });
    await rule({
      name: "Kickoff handoff",
      description: "Tell the account manager and delivery team, create the kickoff task and hand off to project management.",
      category: "handoff",
      trigger: "ready_for_kickoff",
      actions: [
        { type: "notify_staff", to: "onboarding_owner", message: "{{client_name}} is Ready for Kickoff. Book the kickoff call.", email: true },
        { type: "notify_staff", to: "managers", message: "{{client_name}} is Ready for Kickoff." },
        { type: "create_task", title: "Run kickoff call with {{client_name}}", assignee: "onboarding_owner", dueInDays: 3, required: false },
        { type: "trigger_integration", provider: "clickup", name: "Kickoff: {{client_name}}" },
        { type: "chat_notification", provider: "slack", message: "{{client_name}} is Ready for Kickoff. Owner: {{owner_name}}." },
      ],
    });
    await rule({
      name: "Brand files submitted: notify design lead",
      description: "Let Priya know as soon as a client uploads brand files.",
      trigger: "item_submitted",
      runMode: "every_event",
      conditions: [{ type: "event_item_category_is", category: "brand" }],
      actions: [{ type: "notify_staff", to: { userId: priya }, message: "{{client_name}} submitted {{item_title}} for review." }],
    });
    await rule({
      name: "Client 3 days late: alert account manager",
      description: "A required client item is 3 or more days overdue.",
      category: "escalation",
      trigger: "deadline_overdue",
      triggerConfig: { days: 3 },
      actions: [{ type: "notify_staff", to: "account_manager", message: "{{client_name}}: {{item_title}} is 3+ days overdue.", email: true }],
    });
    await rule({
      name: "Client 7 days late: alert operations manager",
      description: "A required client item is 7 or more days overdue.",
      category: "escalation",
      trigger: "deadline_overdue",
      triggerConfig: { days: 7 },
      actions: [{ type: "notify_staff", to: "managers", message: "{{client_name}}: {{item_title}} is 7+ days overdue. Readiness {{readiness}}.", email: true }],
    });
    await rule({
      name: "Review waiting 48 hours: alert reviewer",
      description: "A client submission has waited 48 hours for staff review.",
      category: "escalation",
      trigger: "review_waiting",
      triggerConfig: { hours: 48 },
      actions: [{ type: "notify_staff", to: "reviewer", message: "{{item_title}} from {{client_name}} has waited 48 hours for review." }],
    });
    await rule({
      name: "Client inactive 10 days: mark At Risk",
      description: "No client activity for 10 days while items are outstanding.",
      category: "escalation",
      trigger: "client_inactive",
      triggerConfig: { days: 10 },
      actions: [
        { type: "update_stage", stage: "at_risk", reason: "No client activity for 10 days" },
        { type: "notify_staff", to: "managers", message: "{{client_name}} is At Risk: no client activity for 10 days. Readiness {{readiness}}.", email: true },
        { type: "notify_staff", to: "account_manager", message: "{{client_name}} is At Risk. Consider a call." },
      ],
    });
    await rule({
      name: "High-value deal: notify managers",
      description: "Example rule, turned off: tell managers when a deal over $20,000 starts onboarding.",
      trigger: "onboarding_started",
      enabled: false,
      conditions: [{ type: "deal_value_at_least", amount: 20000 }],
      actions: [{ type: "notify_staff", to: "managers", message: "High-value onboarding started: {{client_name}}." }],
    });

    // Fixture writes fired the event triggers; those are not real activity, so drop them before the engine runs.
    await tx.q("delete from automation_events where workspace_id = $1", [ws]);

    // ---- Second workspace (isolation demo) ------------------------------------
    const ws2 = (await tx.one<{ id: string }>(
      `insert into workspaces (name, slug, is_demo, brand_color, timezone, email_from_name) values ('Ledgerline Accounting (Demo)', 'ledgerline-demo', true, '#4f46e5', 'America/New_York', 'Ledgerline Accounting') returning id`,
    ))!.id;
    const nora = await user(tx, "nora@ledgerline.example.com", "Nora Ellis");
    await tx.q("insert into memberships (workspace_id, user_id, role, can_approve) values ($1,$2,'admin',true),($1,$3,'manager',false)", [ws2, nora, olivia]);
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
    await createOnboardingFromTemplate(tx, { workspaceId: ws2, clientId: fern, templateId: t2, ownerUserId: nora, startDate: ago(3) });
    await tx.q("delete from automation_events where workspace_id = $1", [ws2]);
    await rebuildHistory(tx, ws2);
  });

  if (!demoWorkspaceId) return;

  // ---- Real engine runs ---------------------------------------------------------
  // Michael gives final approval on Summit Roofing; the database emits the event and the engine
  // marks it Ready for Kickoff and runs the handoff rule (demo: notifications recorded, nothing sent).
  await withTenant({ workspaceId: demoWorkspaceId, userId: michaelId, role: "staff" }, async (tx) => {
    await tx.q(
      "update onboarding_items set status = 'approved', reviewed_at = now(), reviewed_by = $2, updated_at = now() where onboarding_id = $1 and item_key = 'final_approval'",
      [summitOnboarding, michaelId],
    );
    await tx.q(
      `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, client_id, onboarding_id, category)
       select workspace_id, $2, 'item.approved', 'item', id, 'Completed task "' || title || '"', client_id, onboarding_id, 'item'
       from onboarding_items where onboarding_id = $1 and item_key = 'final_approval'`,
      [summitOnboarding, michaelId],
    );
  });

  // A closed-won deal arrives from HubSpot (simulated in the demo; no HubSpot account is contacted).
  await importClosedWonDeal(
    demoWorkspaceId,
    {
      provider: "hubspot",
      externalId: "demo-deal-48213",
      dealName: "Peak Performance Physio - Paid Ads retainer",
      companyName: "Peak Performance Physio",
      website: "https://peakphysio.example.com",
      industry: "Healthcare",
      timezone: "America/Denver",
      contactName: "Nate Collins",
      contactEmail: "nate@peakphysio.example.com",
      amount: 8000,
      recurrence: "monthly",
      serviceType: "Paid Ads",
    },
    { simulated: true },
  );

  await processPendingEvents({ workspaceId: demoWorkspaceId });
  const time = await runTimeTriggers({ workspaceId: demoWorkspaceId });
  await processPendingEvents({ workspaceId: demoWorkspaceId });

  await printReadiness(demoWorkspaceId);
  return time;
}

/**
 * Rebuilds item status history and the matching audit trail from each item's backdated timestamps,
 * so reports and timelines read the same records the app writes in normal use.
 */
async function rebuildHistory(tx: Tx, ws: string) {
  await tx.q("delete from item_status_history where workspace_id = $1", [ws]);
  const items = await tx.q<{
    id: string;
    client_id: string;
    onboarding_id: string;
    title: string;
    audience: string;
    kind: string;
    status: string;
    submitted_at: Date | null;
    reviewed_at: Date | null;
    reviewed_by: string | null;
    reviewer_user_id: string | null;
    owner_user_id: string | null;
    status_changed_at: Date;
    created_at: Date;
    contact: string | null;
  }>(
    `select i.id, i.client_id, i.onboarding_id, i.title, i.audience, i.kind, i.status, i.submitted_at, i.reviewed_at, i.reviewed_by,
       i.reviewer_user_id, o.owner_user_id, i.status_changed_at, o.created_at,
       (select m.user_id from memberships m where m.client_id = i.client_id and m.role = 'client' order by m.created_at limit 1) as contact
     from onboarding_items i join onboardings o on o.id = i.onboarding_id where i.workspace_id = $1`,
    [ws],
  );
  const rows: unknown[][] = [];
  const audits: unknown[][] = [];
  const add = (it: (typeof items)[number], from: string | null, to: string, at: Date, actor: string | null, role: string | null) =>
    rows.push([ws, it.client_id, it.onboarding_id, it.id, from, to, actor, role, at]);
  const log = (it: (typeof items)[number], actor: string | null, action: string, summary: string, at: Date) =>
    audits.push([ws, actor, action, "item", it.id, summary, it.client_id, it.onboarding_id, action.split(".")[0], at]);

  for (const it of items) {
    add(it, null, "not_started", it.created_at, null, "system");
    if (it.audience === "internal") {
      if (it.status === "approved" && it.reviewed_at) {
        add(it, "not_started", "approved", it.reviewed_at, it.reviewed_by, "staff");
        log(it, it.reviewed_by, "item.approved", `Completed task "${it.title}"`, it.reviewed_at);
      }
      continue;
    }
    let last = "not_started";
    if (it.status === "in_progress") add(it, last, "in_progress", it.status_changed_at, it.contact, "client");
    if (it.submitted_at) {
      if (last === "not_started" && it.status !== "in_progress") {
        add(it, last, "submitted", it.submitted_at, it.contact, "client");
        log(it, it.contact, "item.submitted", `Submitted "${it.title}"`, it.submitted_at);
        last = "submitted";
      }
    }
    if (it.status === "under_review") {
      const reviewer = it.reviewer_user_id ?? it.owner_user_id;
      add(it, last, "under_review", it.status_changed_at, reviewer, "staff");
      log(it, reviewer, "item.updated", `Started reviewing "${it.title}"`, it.status_changed_at);
    }
    if ((it.status === "approved" || it.status === "changes_requested") && it.reviewed_at) {
      add(it, last, it.status, it.reviewed_at, it.reviewed_by, "staff");
      log(
        it,
        it.reviewed_by,
        it.status === "approved" ? "item.approved" : "item.changes_requested",
        it.status === "approved" ? `Approved "${it.title}"` : `Requested changes on "${it.title}"`,
        it.reviewed_at,
      );
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await tx.q(
      `insert into item_status_history (workspace_id, client_id, onboarding_id, item_id, from_status, to_status, actor_user_id, actor_role, created_at)
       values ${chunk.map((_, j) => `(${Array.from({ length: 9 }, (_, k) => `$${j * 9 + k + 1}`).join(",")})`).join(",")}`,
      chunk.flat(),
    );
  }
  for (let i = 0; i < audits.length; i += 500) {
    const chunk = audits.slice(i, i + 500);
    await tx.q(
      `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, client_id, onboarding_id, category, created_at)
       values ${chunk.map((_, j) => `(${Array.from({ length: 10 }, (_, k) => `$${j * 10 + k + 1}`).join(",")})`).join(",")}`,
      chunk.flat(),
    );
  }
  // Onboarding and client creation entries, then last client activity from real submissions and comments.
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, client_id, onboarding_id, category, created_at)
     select o.workspace_id, o.owner_user_id, 'onboarding.created', 'onboarding', o.id,
            case when o.source = 'import' then 'Imported completed onboarding "' || o.name || '"' else 'Started onboarding "' || o.name || '"' end,
            o.client_id, o.id, 'onboarding', o.created_at
     from onboardings o where o.workspace_id = $1`,
    [ws],
  );
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, client_id, onboarding_id, category, created_at)
     select o.workspace_id, o.completed_by, 'onboarding.completed', 'onboarding', o.id, 'Approved onboarding as complete', o.client_id, o.id, 'onboarding', o.completed_at
     from onboardings o where o.workspace_id = $1 and o.status = 'completed' and o.source <> 'import'`,
    [ws],
  );
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, client_id, category, created_at)
     select c.workspace_id, c.owner_user_id, 'client.created', 'client', c.id,
            'Added client ' || c.name || case when c.source <> 'manual' then ' (from ' || c.source || ')' else '' end, c.id, 'client', c.created_at - interval '1 minute'
     from clients c where c.workspace_id = $1`,
    [ws],
  );
  await tx.q(
    `update onboardings o set last_client_activity_at = greatest(
       (select max(submitted_at) from onboarding_items i where i.onboarding_id = o.id),
       (select max(status_changed_at) from onboarding_items i where i.onboarding_id = o.id and i.status = 'in_progress'),
       (select max(c.created_at) from comments c join memberships m on m.user_id = c.author_user_id and m.role = 'client' where c.onboarding_id = o.id))
     where o.workspace_id = $1`,
    [ws],
  );
}

async function printReadiness(ws: string) {
  await withTenant({ workspaceId: ws, userId: null, role: "system" }, async (tx) => {
    const onbs = await tx.q<{ id: string; name: string; status: string; at_risk: boolean; kickoff_ready_at: Date | null; kickoff_date: string | null; start_date: string }>(
      `select o.*, c.name from onboardings o join clients c on c.id = o.client_id where o.status in ('active', 'paused') order by c.name`,
    );
    for (const o of onbs) {
      const items = await tx.q("select * from onboarding_items where onboarding_id = $1 and removed_at is null order by position", [o.id]);
      const state = computeOnboardingState(o as never, items as never);
      console.log(
        `${o.name.padEnd(26)} ${String(state.readiness.score).padStart(3)}%  ${state.stage.padEnd(15)} ${o.at_risk ? "AT RISK " : ""}${o.kickoff_ready_at ? "READY " : ""}blockers=${state.blockers.length}`,
      );
    }
  });
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then((time) => {
      if (time) console.log("Time triggers:", JSON.stringify(time));
      console.log(`Seeded demo data. Staff: olivia@northstar.example.com / ${DEMO_PASSWORD}. Client: john@johnsondental.example.com / ${DEMO_PASSWORD}`);
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
