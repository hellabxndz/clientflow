# ClientFlow

Onboarding operations for service firms. When a deal closes, ClientFlow creates the client, starts the right onboarding, chases what's missing, routes submissions to the right reviewer, explains what is blocking kickoff, and hands the client to delivery when they're ready.

The demo is a marketing agency, **Northstar Growth Agency (Demo)**. A second demo workspace, Ledgerline Accounting, shows the multi-workspace switcher and the accounting template.

**Status: evaluation build, not production.** Read [Before handling sensitive production documents](#before-handling-sensitive-production-documents) and [Before a paid pilot](#before-a-paid-pilot). No SOC 2, HIPAA, GDPR, ISO or other certification is claimed. Security details and known gaps are in [docs/SECURITY.md](docs/SECURITY.md).

## Product story (what the demo shows)

1. Johnson Dental closes as a $15,000/month Paid Ads deal in HubSpot (simulated in the demo).
2. ClientFlow creates the client, starts the Paid Ads onboarding, assigns Sarah as account manager and invites the client.
3. The client opens the branded portal on a phone and sees "What's blocking kickoff".
4. They grant Google Ads access by invitation. ClientFlow refuses anything that looks like a password.
5. They replace the logo that Priya, the design lead, sent back.
6. Priya approves it from her review queue. Sarah approves the access.
7. The readiness score reaches 100 and the automation engine marks the client **Ready for Kickoff**.
8. Sarah and the managers are notified once, a kickoff task is created, and the PM handoff is recorded (not sent, because this is a demo).
9. The Overview, timeline and reports reflect the change.

`npm run e2e` performs exactly this walk-through in a browser and checks the database at each step.

## 1. Completed features

**Staff navigation:** Overview, Clients, Templates, Tasks, Documents, Automations, Reports, Integrations, Settings.

- **Overview.** KPIs (active, ready for kickoff, at risk, overdue, awaiting review), "waiting on client / staff / third party", top blocker cards with owner and reason, contract value in onboarding (monthly and one-time totals kept apart), Ready for Kickoff list, recent automation activity.
- **Clients.** Filters for stage, who it's waiting on, risk, overdue, owner, client type and search. Each client page has readiness, blockers, requirements by section, review actions, kickoff date and projected kickoff, at-risk flag, timeline, documents, an AI panel, and template upgrade with a preview.
- **Readiness score and blocker intelligence.** Weighted by item weight, with critical items counting double. Approved items earn full credit and submitted items half. Overdue or sent-back critical items cost up to 12 points. The score is 100 only when every required item is approved. Each blocker is categorised (waiting on client, staff review, third party, dependency, overdue) and says who owns it.
- **Automation engine and builder.** Triggers, AND/OR conditions and ordered actions:
  - **Triggers:** item submitted/approved, changes requested, deadline approaching/overdue, client inactive, review waiting, all required completed, deal imported, and more.
  - **Actions:** notify staff, email the client (demo: recorded only), create a task, assign an owner or reviewer, mark at risk, mark Ready for Kickoff, post to Slack/Teams, create a PM task, and more.
  - **Run modes:** once per onboarding, or every event. Every run is claimed by a unique key in the database, so retries and overlapping jobs never duplicate a notification or task.
  - **Activity log:** each run with its outcome per action.
  - Admins and managers edit rules; staff can read them.
- **CRM closed-won automation.**
  - HubSpot (v3 signature), Pipedrive (basic auth), Salesforce and a generic signed-webhook endpoint normalize a won deal and create the client, contact, deal value and onboarding from the client type's template, assign the default owner and invite the client.
  - The same deal delivered twice creates nothing new.
  - Demo workspaces refuse live webhooks and offer a "Simulate closed-won deal" form that runs the same pipeline.
- **Client portal.**
  - Branding: logo, colors, name and welcome.
  - Home: a "What's blocking kickoff" section, readiness with a plain explanation, next steps, and deadlines.
  - Item types: forms, file requests with versions, checklists, questions, tracked e-signature steps, and account-access requests with delegated-access instructions.
  - A sticky Next button on phones, messages to the team, and answers kept when a submit is rejected.
- **Smart documents.** Versions, expiry dates, scan status, sensitive categories (legal, financial, tax, identity) that always need human review, and short-lived download links.
- **Review queue.** Under Tasks → Review queue: Mine, Unassigned or by person; start review, approve, request changes, comment and reassign without opening the item. Template items route to a default reviewer (brand items go to Priya in the demo).
- **Smart reminders and escalations.**
  - Reminder rules: before due, overdue, missing access, unanswered questions.
  - Each rule has quiet hours in the client's time zone and stops automatically once the item moves.
  - Scheduled reminders are re-checked at send time.
  - Escalations to the owner or managers run through the automation engine.
- **AI assistant.**
  - Summarizes progress, explains blockers, drafts a reminder and flags missing information.
  - It drafts only and cannot approve anything.
  - Document contents are not sent unless an admin turns on "Allow AI to process uploaded documents" (off by default).
  - Without an API key it falls back to rule-based output and says "AI assistance unavailable — core onboarding features remain active."
- **Executive dashboard, staff workload and reports.**
  - Report contents: time to kickoff, time to complete, by-template and by-type breakdowns, bottleneck items, review turnaround, workload per person, reminder effectiveness, and before/after-launch comparison.
  - Contract value is labelled as value in onboarding, never as realized revenue.
  - The before/after comparison shows recorded durations and counts only, needs a minimum sample on both sides, and does not estimate hours or money saved.
  - Sparse data shows "Not enough data yet."
- **Templates.** Five agency templates (Paid Ads, SEO, Website, Full-Service, Social Media) plus accounting.
  - Item settings: weight, critical, category, review required, default reviewer, dependencies and "due after dependency".
  - Dependency loops are prevented.
  - Versions are immutable. Live onboardings keep their version until staff upgrade them, with a preview of what changes.
- **PM handoff.** On Ready for Kickoff, builds a handoff summary and creates a task in ClickUp, Asana or Monday.com when connected (recorded only in demo).
- **CSV import.** Clients, contacts, historical onboardings, tasks and requirements, with column mapping, validation, duplicate detection and an import log. Imported history feeds the before/after report.
- **Client timeline.** Status changes, reviews, uploads, comments, automations, reminders and handoffs in one list per client.
- **Multi-workspace and roles.** Admin, Manager, Staff, Client. Every permission is checked in the server action and again by Postgres row-level security.
- **Sign-in security.**
  - Password reset by emailed link: single-use, valid 60 minutes, stored only as a hash, never reveals whether an account exists, and signs the account out everywhere. The link is withheld from the stored email log.
  - Two-step sign-in with any authenticator app (TOTP), set up from **Your account** with a QR code, plus 8 single-use recovery codes. Each code works once. The secret is encrypted at rest.
  - Admins can require two-step sign-in for the whole team (enforced on every page, action and download) and reset it for someone who lost their phone.
  - Users can change their password; other devices are signed out.
- **Security and audit.**
  - Audit log of sign-ins, reviews, uploads, downloads, invitations, settings, automations, integrations and AI use, filterable in Settings.
  - Sessions can be revoked.
  - Invitations are single-use and hashed.
  - Sign-in and webhook throttling are stored in Postgres.
- **Implementation mode.** Settings → Launch Checklist tracks setup steps (branding, team, templates, client types, reminders, integrations, import, test client) from real configuration.
- **Pilot Readiness.** Settings → Pilot Readiness lists what is Working, what Requires Configuration and what is Not Yet Implemented, computed live from this deployment.
- **Integrations hub.**
  - Honest states only: Not Connected, Configuration Required, Connected (only after a real test call or verified webhook), Error, and Coming Soon.
  - Credentials are encrypted with AES-256-GCM and are never readable by the app's database role.

## 2. Partial features

- **Integrations.** The HubSpot, Pipedrive, Salesforce, Slack, Teams, ClickUp, Asana, Monday.com and Resend adapters are written against the providers' documented APIs and covered by unit tests. None has been verified against a live account.
- **Coming Soon (no adapter yet):** Gmail, Outlook, Google Drive, Dropbox, QuickBooks, DocuSign, Meta Business Manager, Google Ads.
- **E-signature** is a tracked step: the client confirms they signed in your tool and staff check the signed copy.
- **Custom domain.** The field stores the domain and offers a DNS check, which has not been tested against live DNS. TLS and routing are not provisioned.
- **Automation builder pickers.** On a rule scoped to "All templates", the item and section conditions take the item key as text (for example `access_google_ads`). Scoping the rule to a template gives dropdowns.
- **Portal dependencies.** A client item that depends on an internal task shows as not started rather than "Blocked" in the portal. Staff see the dependency.
- **Filtered links.** The "Automations" and "Reminders" links on a template page open the full lists, not lists filtered to that template.

## 3. Environment variables

See `.env.example` for every variable with comments.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection |
| `APP_URL` | Yes | Public base URL for links in emails and webhook URLs |
| `SESSION_SECRET` | Yes (prod refuses to start without it) | Signs download links; fallback key source |
| `STORAGE_DIR` | Yes | Private file storage directory, outside the web root |
| `INTEGRATION_ENCRYPTION_KEY` | Before storing real credentials | AES-256-GCM key for integration secrets, at least 32 characters |
| `CRON_SECRET` | For scheduled jobs | Bearer token for `/api/cron/tick` and `/api/cron/reminders`, at least 24 characters |
| `RESEND_API_KEY`, `EMAIL_FROM` | For real email | Invitations, reminders, client emails |
| `DISABLE_EMAIL_SENDING` | No | `true` simulates all email everywhere (staging) |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | No | AI assistant; rule-based fallback without it |
| `CLAMAV_HOST`, `CLAMAV_PORT` | Before sensitive documents | Malware scanning through clamd |
| `INVITE_TTL_HOURS` | No | Invitation lifetime (default 168) |
| `SHOW_DEMO_LOGINS` | No | Show demo sign-in shortcuts |
| `TEST_DATABASE_URL` | For tests | Separate database, reset on each run |

## 4. Migrations

- SQL files live in `db/migrations`:
  - `001_init.sql` is the core schema, roles, row-level security and triggers.
  - `002_operations.sql` adds automations, readiness, CRM, integrations, imports, notifications, the manager role and the extra policies.
  - `003_account_security.sql` adds password reset links, two-step sign-in and the scanning policy setting.
- `npm run db:migrate` applies pending files in order and records them in `schema_migrations`.
- `npm run db:reset` drops everything, migrates and reseeds the demo. Never run it against real data.
- The first migration creates the `clientflow_app` role that requests switch to so RLS applies. The connecting user needs permission to create roles once. On a managed database, create the role by hand first.
- Upgrading an existing ClientFlow MVP database: back it up, then run `npm run db:migrate`. `002` and `003` only add tables, columns, functions and policies, and backfill defaults.

## 5. Development setup

Requirements: Node 20+ (tested on 22), PostgreSQL 14+ (tested on 16).

```bash
npm install
cp .env.example .env              # set DATABASE_URL and SESSION_SECRET at minimum
createdb clientflow
npm run db:reset                  # migrate + load the Northstar demo
npm run dev                       # http://localhost:3000
```

Scheduled jobs:

- `npm run jobs:tick` processes automation events, time-based triggers, escalations and reminders. Run it every 5–15 minutes, or call `POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET`.
- `npm run jobs:retention` runs daily and purges stored files past each workspace's retention period.

Overlapping runs are safe.

## 6. Integration configuration

Admins configure integrations under **Integrations**. Demo workspaces refuse live webhooks and never call external services; create a non-demo workspace to connect real accounts.

| Integration | What to set | Webhook / notes |
| --- | --- | --- |
| HubSpot | App client secret; won stage id (default `closedwon`) | Subscribe to `deal.propertyChange` on `dealstage`, pointing at `/api/integrations/hubspot/webhook?workspace=<slug>`. Requests are checked with the v3 signature and rejected after 5 minutes |
| Pipedrive | Basic-auth password; won status | Webhook on deal updated, `/api/integrations/pipedrive/webhook?workspace=<slug>` with user `clientflow` |
| Salesforce | Shared secret | Flow HTTP callout posting the generic JSON with `X-ClientFlow-Signature` |
| Any CRM (Zapier, Make) | Shared secret | POST `{"event":"deal.closed_won","deal":{…},"company":{…},"contact":{…}}`, header `X-ClientFlow-Signature: sha256=<HMAC-SHA256 of raw body>` |
| Slack / Microsoft Teams | Incoming webhook URL / Workflows webhook URL | "Test connection" posts a test message; only success marks it Connected |
| ClickUp / Asana / Monday.com | API token plus list / project / board id | Used by the "Create PM task" action and the kickoff handoff |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` on a verified domain | Shown in Settings → Email |
| ClamAV | `CLAMAV_HOST`, `CLAMAV_PORT` (`docker compose up -d clamav` runs one locally) | Without it every file says "Not scanned". Settings → Security → **Test scanner** sends the standard EICAR test file; the scanner shows Connected only after that test passes. **Refuse unscanned files** blocks uploads whenever no scanner answers |
| Anthropic | `ANTHROPIC_API_KEY` | Settings → AI lists exactly what is sent |

Map each CRM service type to a **client type** (Settings → Client Types). Each client type has a template and a default owner, which together decide the onboarding and owner that a won deal gets.

## 7. Demo accounts

The password for every account is `demo-password-123`. Everything is fictional and nothing is ever sent.

| Who | Email | Role |
| --- | --- | --- |
| Olivia Bennett | olivia@northstar.example.com | Admin, Northstar (also Manager in Ledgerline) |
| Marcus Reed | marcus@northstar.example.com | Manager |
| Sarah Kim | sarah@northstar.example.com | Staff, account manager |
| Michael Torres | michael@northstar.example.com | Staff |
| Priya Shah | priya@northstar.example.com | Staff, design lead (brand reviewer) |
| John (Johnson Dental) | john@johnsondental.example.com | Client: Paid Ads, logo sent back, Google Ads access overdue |
| Lena (Acme Fitness) | lena@acmefitness.example.com | Client: brand files awaiting review |
| Ava (Luxe Skin Studio) | ava@luxeskin.example.com | Client: Full-Service, mid-way |
| Tom (Summit Roofing) | tom@summitroofing.example.com | Client: SEO, Ready for Kickoff |
| Rachel (Brightline Legal) | rachel@brightlinelegal.example.com | Client: Website, quiet 11 days, At Risk |
| Dana (Riverbend Plumbing) | dana@riverbendplumbing.example.com | Client: paused |
| Nora Ellis | nora@ledgerline.example.com | Admin, Ledgerline Accounting (Demo) |

Peak Performance Physio arrives through the simulated HubSpot deal. Five completed post-launch onboardings and six imported pre-launch onboardings feed the reports.

## 8. Test results

```bash
createdb clientflow_test
npm test                 # Vitest against a real Postgres database
npm run e2e              # browser walk-through; app running on :3000 with a fresh `npm run db:reset`
npm run screenshots -- ./shots   # 38 screens at 1440px and 390px; flags overflow and console errors
```

Results from this build:

- **Unit and integration tests:** 15 files, 128 tests, all passing (with `CLAMAV_TEST_HOST` set; 127 without, because the live ClamAV test is skipped). They cover:
  - Tenant and client isolation, including the user and membership directory.
  - Role permissions, and integration credentials being unreadable.
  - Automation dedupe, conditions and loop safety, plus the completion guard.
  - Readiness scoring.
  - CRM signatures and duplicate deals.
  - CSV import validation.
  - Template versioning and upgrades.
  - Reminders: quiet hours, stop conditions and send-time re-checks.
  - Files, invitations, sessions and retention.
  - Password reset (single use, expiry, sign-out everywhere, no link in the log) and two-step sign-in (RFC 6238 test vectors, replay refusal, single-use recovery codes, encrypted secret unreadable by the app role).
  - Malware scanning against a real clamd: detects the EICAR test file, passes a clean file, treats an unreachable scanner as an error. This test found and fixed a bug where every clean file would have been marked as a scanner error. It ran against a local clamd loaded with only a test signature, because this environment couldn't download ClamAV's signature databases.
- **Browser walk-through:** all 12 checks passed, covering the product story above, client isolation (another client's item returns 404 and the staff app redirects), honest integration states, no real email sent, setting up and using two-step sign-in, and a full password reset.
- **Screens:** 76 captures (38 desktop, 38 mobile). No horizontal overflow and no console errors.
- **Type check:** `tsc --noEmit` is clean, and `next build` succeeds.

## 9. Limitations

- No SSO or SAML. Two-step sign-in supports authenticator apps only (no SMS, passkeys or security keys).
- Files are stored on local private disk only. That means one app instance, unless the storage directory is shared.
- No integration has been verified against a live account. See [Partial features](#2-partial-features).
- Custom domains are not provisioned (TLS, routing).
- Email delivery status is what the provider returns at send time. There is no bounce or complaint webhook yet.
- The readiness score and the reports are only as good as the template weights and the data entered. There is no ROI calculator; the before/after report compares recorded data only.
- Accessibility was checked at desktop and mobile widths, not with a screen reader or a WCAG audit.

## 10. Security considerations

See [docs/SECURITY.md](docs/SECURITY.md). In short:

- **Isolation.** Postgres RLS enforces tenant and client isolation on every table, under a restricted database role, as well as in server code.
- **No passwords.** Clients are never asked for passwords. Access is requested by delegated invitation, and password-like text is refused before it is stored.
- **Files.** Stored privately, and downloaded only through 5-minute links bound to the user.
- **Integration secrets.** Encrypted, and not readable by the app role.
- **Demo mode.** Never sends email or calls external services.
- **AI.** Never approves anything. Sensitive categories always need a person to approve. Document contents go to the AI provider only if an admin opts in.

## 11. Before handling sensitive production documents

1. Run ClamAV with up-to-date signatures (`docker-compose.yml` has one), set `CLAMAV_HOST`, and press **Test scanner** in Settings → Security until it shows Connected. Until then the UI says "File scanning integration not configured. Enable before handling sensitive production documents."
2. Turn on **Refuse unscanned files**, so an outage of the scanner stops uploads instead of letting unscanned files in.
3. Move files to encrypted object storage (S3-compatible, with server-side encryption and backups). The `StorageAdapter` interface in `src/lib/storage.ts` is the place to add it.
4. Set a dedicated `INTEGRATION_ENCRYPTION_KEY` and a strong `SESSION_SECRET`, and keep both in a secret manager.
5. Turn on **Require two-step sign-in for the team** (Settings → Security) once every admin has set it up.
6. Commission an external penetration test and an RLS policy review.
7. Write a privacy policy and data processing terms. Decide the retention period and the AI document setting per workspace.
8. Set up backups with a tested restore, error monitoring, and log retention.

## 12. Before a paid pilot

1. Deploy to a host with HTTPS. Set `APP_URL`, `CRON_SECRET` and a scheduler calling `/api/cron/tick`.
2. Verify a sending domain in Resend (SPF, DKIM, DMARC) and send a test invitation and reminder.
3. Connect the pilot's CRM in a non-demo workspace. Close a test deal and confirm one client and one onboarding are created.
4. Connect Slack or Teams and the PM tool, and run "Test connection" until each shows Connected.
5. Build the pilot's templates and client types. Set reviewer routing and reminder rules, and preview each rule.
6. Import historical onboardings by CSV so the before/after report has a baseline.
7. Run one internal test client end to end with `npm run e2e`-style steps.
8. Work through Settings → Launch Checklist and Pilot Readiness until nothing critical is left in "Requires configuration".
9. Complete items 1–8 of [section 11](#11-before-handling-sensitive-production-documents) if the pilot will upload sensitive documents.

## Project layout

```
db/migrations/      SQL schema, roles, row-level security, triggers
scripts/            migrate, seed, jobs, e2e walk-through, screenshots
src/lib/            domain logic (auth, readiness, automation engine, integrations, reminders, AI, reports, import)
src/app/app/        staff workspace
src/app/portal/     client portal
src/app/api/        file links, cron, CRM webhooks, branding logo, health
tests/              Vitest suites against Postgres
docs/SECURITY.md    security model and known gaps
```
