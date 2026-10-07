# ClientFlow security model

This document describes what this build actually does, and what it does not. It is not a certification. ClientFlow claims no SOC 2, HIPAA, GDPR, ISO 27001 or other compliance status, and none of this has had an external review.

## Tenant and client isolation

- Every request runs inside `withTenant`. It switches to the restricted Postgres role `clientflow_app` and sets `app.workspace_id`, `app.user_id`, `app.role` and `app.client_id` for that transaction.
- Every tenant table has row-level security policies built on those settings:
  - Staff see only their workspace.
  - Clients see only their own company's onboardings, items, files, comments and contacts, plus the names of the team serving them.
  - Clients cannot read rules, runs, integrations, imports, notifications, client types or other clients' users.
- Server actions check roles first. The database checks again, so hiding something in the UI is never the only control.
- A trigger limits which columns a client may change.
- Only staff can create notifications, and only for staff in the same workspace (`app.create_notification`, SECURITY DEFINER).
- Only the automation engine (owner role) writes automation run records.
- Tests query as each role and assert what is and isn't visible: `tests/isolation.test.ts`, `tests/roles.test.ts`.

## Roles

| Capability | Admin | Manager | Staff | Client |
| --- | --- | --- | --- | --- |
| Integrations, team, security settings | Yes | No | No | No |
| Automations, templates (default), reassign reviews | Yes | Yes | No | No |
| Review, approve items, manage clients | Yes | Yes | Yes | No |
| Own portal items | No | No | No | Yes |

Template editing can be opened to all staff from Settings.

## Credentials and passwords

- **Clients are never asked for passwords.** Account access items explain how to invite the agency in each platform (delegated access).
- The template validator rejects fields that ask for a password.
- The portal refuses password-like text in access notes, checklists, answers and messages before anything is stored, even as a draft.
- Staff passwords are hashed with bcrypt.
- Sessions and invitation tokens are stored as hashes. Invitations are single-use and expire. Sessions can be revoked per device or for everyone.
- Sign-in and webhook throttling are stored in Postgres, so they hold across processes.
- Integration secrets are encrypted with AES-256-GCM under `INTEGRATION_ENCRYPTION_KEY`, which falls back to a key derived from `SESSION_SECRET`, with a warning in the UI. The `clientflow_app` role has no SELECT on the encrypted column.

## Files

- Files are stored under random keys in `STORAGE_DIR`, outside the web root. There is no public URL.
- A download first checks access as the signed-in user. It then redirects to a signed link that expires in five minutes and is bound to that user.
- Type and size limits apply per item and per workspace. Signatures are checked for common formats and executable types are blocked. SVG is refused for branding logos.
- **Scanning.**
  - With `CLAMAV_HOST` set, every upload is scanned through clamd and infected files are rejected.
  - Without it, each file is stored as "Not scanned", and the app shows: "File scanning integration not configured. Enable before handling sensitive production documents."
  - Scanning is never faked.
- Retention purges file bytes after the workspace's retention period.

## Reviews and approvals

- Items in the legal, financial, tax or identity category always need a person to approve them, even when the template says review isn't required.
- No automation action approves items.
- The AI assistant drafts text only and cannot approve anything.
- An onboarding cannot move to completed while any required item is unapproved. A database trigger enforces this.

## AI

- AI is off when no `ANTHROPIC_API_KEY` is set. It can also be switched off per workspace. In both cases the app uses rule-based summaries and says AI is unavailable.
- What is sent: item titles, statuses, dates, form answers and client-visible comments. Settings → AI lists exactly this.
- Document contents are **not** sent unless an admin turns on "Allow AI to process uploaded documents" (off by default). Even then, only plain-text formats are included.
- All onboarding data is passed as data, not instructions, and output is labelled as a draft.

## Demo mode

- Demo workspaces never send email. Messages are recorded with status `simulated`.
- Demo workspaces never call Slack, Teams or PM tools. Calls are recorded as skipped.
- Demo workspaces refuse live CRM webhooks.
- The end-to-end check asserts that no email has status `sent`.

## Webhooks

- HubSpot requests are checked against the v3 signature and rejected if older than five minutes.
- Pipedrive requests are checked with basic auth.
- Salesforce and the generic endpoint require an HMAC-SHA256 signature of the raw body.
- Comparisons are constant-time. A deal delivered twice is detected by provider and deal id, and creates nothing new.

## Audit

The audit log records:

- Sign-ins.
- Invitations.
- Reviews and auto-approvals.
- Uploads and downloads.
- Setting changes.
- Member changes.
- Automation and integration changes.
- Imports.
- AI use.

Admins can filter it in Settings → Audit Log. Status history per item is kept in `item_status_history`.

## Known gaps

- No SSO, SAML or MFA, and no self-service password reset.
- Local-disk storage only: no encryption at rest beyond the host's disk, and no object storage adapter.
- Bounces and complaints are not processed.
- There has been no penetration test and no external review of the RLS policies.
- Integrations have not been verified against live accounts.
- No data processing terms or privacy policy are included.
- Backups, monitoring and log retention depend on the host and are not set up by this repository.
