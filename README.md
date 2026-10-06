# ClientFlow

Client onboarding and document collection for service firms. Staff build reusable onboarding templates, invite each client to a branded portal, collect forms, files and access checklists, review what comes back, and see what is blocking every onboarding. The demo is set up for a marketing agency; templates for an accounting firm and a blank starter are included.

**Status: MVP for evaluation, not production.** See [Before a paid pilot](#before-a-paid-pilot). No compliance certification (SOC 2, HIPAA, GDPR or otherwise) is claimed.

## Quick start

Requirements: Node 20+ (tested on 22), PostgreSQL 14+ (tested on 16).

```bash
npm install
cp .env.example .env            # set DATABASE_URL and SESSION_SECRET at minimum
createdb clientflow
npm run db:reset                # runs migrations, then loads the demo workspace
npm run dev                     # http://localhost:3000
```

`npm run db:migrate` applies migrations without touching data. `npm run db:reset` drops everything and reseeds the demo.

The migration creates a `clientflow_app` database role that the app switches to inside each request so row-level security applies. The connecting user needs permission to create roles the first time (a superuser locally, or create the role once by hand on a managed database).

### Demo sign-ins

All passwords are `demo-password-123`. Everything in the demo workspace is fictional and labeled "Demo".

| Who | Email | Role |
| --- | --- | --- |
| Maya Chen | maya@northwind.example.com | Admin, Northwind Creative (Demo); staff in Ledgerline Accounting (Demo) |
| Jordan Patel | jordan@northwind.example.com | Staff |
| Sam Rivera | sam@northwind.example.com | Staff, can approve completion |
| Elena Ruiz | elena@harborpine.example.com | Client, Harbor & Pine Coffee (just started) |
| Marcus Webb | marcus@brightline.example.com | Client, Brightline Dental Group (mid-onboarding, changes requested) |
| Nora Ellis | nora@ledgerline.example.com | Admin, Ledgerline Accounting (Demo) |

Demo clients cover each stage: just started, mixed progress with overdue and changes-requested items, ready to start, paused, and completed. Set `SHOW_DEMO_LOGINS=false` to hide the shortcuts on the sign-in page.

### Scheduled jobs

```bash
npm run jobs:reminders   # hourly; safe to overlap, duplicates are prevented
npm run jobs:retention   # daily; purges stored files past each workspace's retention period
```

Alternatively call `POST /api/cron/reminders` with `Authorization: Bearer $CRON_SECRET`. Staff admins can also run both from Settings.

## Tests

```bash
createdb clientflow_test
npm test                 # 61 tests against a real Postgres database (reset on every run)
```

They cover company and client isolation (enforced by RLS, tested by querying as each role), invitation expiry and single use, session revocation, file permissions and upload rules, short-lived download links, reminder stop conditions, time zones and duplicate prevention, template versioning, dependency and blocker logic, and retention.

Browser checks, with the app running on port 3000 and a freshly reset demo database:

```bash
npx tsx scripts/e2e-smoke.ts              # 20 end-to-end flows as staff and client
npx tsx scripts/screenshots.ts ./shots    # desktop 1440px and mobile 390px captures, flags overflow and console errors
```

Set `CHROMIUM_PATH` if Playwright's bundled browser isn't installed (`npx playwright install chromium`).

## What works

**Staff workspace** (Overview, Clients, Tasks, Documents, Templates, Reports, Settings)
- Overview with active onboardings, overdue requests, clients waiting for review and ready to start, plus a blocker list with the owner and why each item is stuck.
- Client pages with progress, per-item review (approve, request changes with a client-visible note), internal notes kept separate from client comments, extra questions and tasks added on the fly, pause and resume, and per-onboarding reminder switch.
- Tasks with owners, due dates and dependencies. A task can't be marked done while what it depends on is unfinished, and the reason is shown.
- Completion approval only by admins or staff marked "can approve", and only when every required item is approved.
- Document review with version history, scan status, and comments.
- Reports computed from records only: average and median time to complete, overdue items by client, most common blockers, open work per owner, and review turnaround. Empty states say when there isn't enough data.

**Templates**
- Sections with forms, file requests, checklists, questions, internal tasks and tracked signature steps; due-date offsets, default owners, dependencies, and required or optional items.
- Publishing creates an immutable version (enforced by a database trigger). Each onboarding copies the version it started from, so editing a template never changes onboardings already underway.
- The agency template covers business details, goals and audience, brand assets, contacts, project requirements, an account-access checklist, and kickoff readiness. Access is requested by inviting the agency's email in each platform; the template validator rejects any field that asks for a password, and the client form explains why.
- Who can edit templates is a workspace setting (admins only, or all staff).

**Client portal**
- Branded with the workspace name, color and welcome message. Shows next steps first: changes requested, then overdue, then due soonest.
- Save progress or submit. Items move through Not Started, In Progress, Submitted, Changes Requested and Approved. Input is kept when validation fails.
- Uploads with type and size limits (per item and per workspace), signature checks on common formats, blocked executable types, and new versions of the same document.
- Message the team on any item. Works on a 390px phone screen.

**Files**
- Stored privately outside the web root under random keys. Downloads go through a link that checks access first and then issues a token valid for 5 minutes, bound to the user.
- Scanning boundary: with `CLAMAV_HOST` set, every upload is scanned through clamd and infected files are rejected. Without it, files are stored as "Not scanned", which is shown on every file, on the Documents page, and in Settings.

**Reminders**
- Rules for before due, overdue, and no activity, with repeat intervals, a send hour in the client's time zone, and no sends after 8pm local time.
- A rule can't be enabled until it has been previewed against real onboardings (enforced in the database too).
- Stops for submitted or approved items, paused or completed onboardings, and onboardings with reminders switched off. One email per rule, onboarding, recipient and local day.
- Every attempt is logged with its status (sent, simulated, failed) and the error, visible in Settings → Email.

**Email**: Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set. Demo workspaces always simulate and never send, regardless of credentials. Settings shows the real connection state. Invitations show a copyable link so onboarding works without email.

**AI assistant** (on each client page): summarize progress, explain blockers, draft a reminder, flag missing information.
- Admins can switch it off per workspace. Settings → AI lists exactly what is sent when a key is configured (item titles, statuses, dates, form answers, comments visible to the client) and what isn't.
- Document contents are never sent unless a second, separate setting is enabled; even then only plain-text files (.txt, .csv, .md) are included.
- It drafts text only. It cannot approve anything, and its output is labeled as a draft to check.
- Without `ANTHROPIC_API_KEY`, or when AI is off, the same buttons produce rule-based summaries, blocker explanations, reminder drafts and missing-information flags.

**Admin and security**
- Multiple workspaces per user with a workspace switcher. Roles: admin, staff, client. Clients only see their own company's records; staff only see their workspace. Enforced in server actions and by Postgres row-level security, including a trigger that limits which columns a client may change.
- Invitations are single-use, stored hashed, and expire (7 days by default). Re-inviting revokes the previous link. Only admins can invite staff.
- Sessions are stored hashed in the database and can be revoked per device, per user, or all at once from Settings → Security.
- Branding, upload limits, retention period, AI settings, and an audit history of sign-ins, reviews, uploads, downloads, invitations, setting changes and AI use.

**Signatures** are a tracked step: the client confirms they signed in your e-signature tool and staff verify the signed copy. The UI says plainly that this is not a legal signature.

## Integrations and what they need

| Integration | Needed for | Without it |
| --- | --- | --- |
| PostgreSQL | Everything | Required |
| Resend (`RESEND_API_KEY`, `EMAIL_FROM` with a verified domain) | Real reminder and invitation emails | Attempts logged as failed "not configured"; copy invite links manually |
| ClamAV daemon (`CLAMAV_HOST`) | Malware scanning | Files stored and flagged "Not scanned" |
| Anthropic API (`ANTHROPIC_API_KEY`) | AI-written summaries and drafts | Rule-based versions |
| Scheduler (cron or similar) | Automatic reminders and retention | Run them from Settings by hand |
| E-signature tool (DocuSign, Dropbox Sign, etc.) | Legal signatures | Tracked as a checklist step only |

## Project layout

```
db/migrations/      SQL schema, roles, row-level security policies, triggers
scripts/            migrate, seed, jobs, browser checks
src/lib/            domain logic (auth, templates, onboarding state, files, reminders, AI, reports)
src/app/app/        staff workspace
src/app/portal/     client portal
src/app/api/        file links and downloads, cron endpoint, health check
tests/              Vitest suites against Postgres
```

## Before a paid pilot

These are known gaps, not a complete security review.

1. **File storage**: only local disk is implemented. Add an S3-compatible adapter with server-side encryption (the `Storage` interface in `src/lib/storage.ts` is the seam) and back it up.
2. **Scanning**: deploy ClamAV (or a hosted scanner) and decide whether unscanned files should be blocked rather than flagged.
3. **Email**: verify a sending domain with Resend (SPF, DKIM, DMARC) and add bounce handling via webhooks. Delivery status is currently what the API returns at send time.
4. **Account recovery**: there is no password reset or magic-link sign-in yet. Add one before real clients rely on it. Consider MFA for staff.
5. **Rate limiting**: sign-in throttling is in memory, per process. Move it to Postgres or Redis when running more than one instance.
6. **E-signature**: integrate a provider if signed documents should be tracked automatically.
7. **Operations**: database backups and restore drills, error monitoring, uptime checks, log retention, and a hosting decision (data residency).
8. **Security review**: an external penetration test and review of the RLS policies before storing real client data. Write a privacy policy and data processing terms; decide what to tell clients about AI processing.
9. **Retention**: purging removes stored file bytes; decide whether form answers and comments also need deleting, and whether clients can request deletion.
10. **Accessibility**: screens were checked at desktop and mobile widths, but not with a screen reader or a formal WCAG audit.
