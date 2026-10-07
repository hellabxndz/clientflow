import Link from "next/link";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { listSessions, INVITE_TTL_HOURS, SESSION_TTL_DAYS } from "@/lib/auth";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { getScanner } from "@/lib/scanning";
import { getStorage } from "@/lib/storage";
import { DOWNLOAD_LINK_TTL_SECONDS } from "@/lib/files";
import { usingFallbackKey } from "@/lib/integrations/crypto";
import { validateEnv } from "@/lib/env";
import { revokeMySessionAction } from "../../actions";
import { sysQuery } from "@/lib/db";
import { resetMemberMfaAction, setBlockUnscannedAction, setRequireMfaAction, testScannerAction } from "./actions";

export const metadata = { title: "Security" };

type Row = { title: string; detail: string };

function List({ rows, icon }: { rows: Row[]; icon: "yes" | "partial" | "no" }) {
  const Icon = icon === "yes" ? CheckCircle2 : icon === "partial" ? CircleDashed : XCircle;
  const color = icon === "yes" ? "text-emerald-600" : icon === "partial" ? "text-amber-600" : "text-ink-400";
  return (
    <ul className="divide-y divide-ink-100">
      {rows.map((r) => (
        <li key={r.title} className="flex gap-3 px-5 py-3">
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-900">{r.title}</p>
            <p className="mt-0.5 text-sm text-ink-600">{r.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function SecurityPage() {
  const auth = await requireStaff();
  const sessions = await listSessions(auth.user.id);
  const scanner = getScanner();
  const envCheck = validateEnv();
  const inviteDays = Math.max(1, Math.round(INVITE_TTL_HOURS / 24));
  const isAdmin = auth.role === "admin";
  const team = await sysQuery<{ id: string; name: string; email: string; role: string; mfa: boolean }>(
    `select u.id, u.name, u.email, m.role, exists (select 1 from user_mfa f where f.user_id = u.id and f.enabled_at is not null) as mfa
     from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 and m.role <> 'client' order by u.name`,
    [auth.workspace.id],
  );
  const withMfa = team.filter((t) => t.mfa).length;
  const [lastTest] = await sysQuery<{ created_at: Date; metadata: { ok?: boolean; detail?: string } }>(
    "select created_at, metadata from audit_events where workspace_id = $1 and action = 'security.scanner_test' order by created_at desc limit 1",
    [auth.workspace.id],
  );
  const scannerVerified = scanner.configured && lastTest?.metadata?.ok === true;

  const implemented: Row[] = [
    { title: "Tenant isolation with row-level security", detail: "Tenant data is queried as a restricted database role. Postgres row-level security scopes every row to this workspace and, for client users, to their own company. Clients can't see internal tasks or internal notes." },
    { title: "Server-side authorization", detail: "Every server action checks the signed-in user's role (Admin, Manager, Staff, Client) before doing anything. Hiding a button is never the only protection." },
    { title: "Private file storage with expiring links", detail: `Files are stored privately (${getStorage().name}), never served from a public folder, and downloaded through links bound to the signed-in user that expire after ${DOWNLOAD_LINK_TTL_SECONDS / 60} minutes.` },
    { title: "Upload checks", detail: "File type allow-lists per request, a blocked list of executable types, content (magic byte) checks for common formats, and a per-workspace size limit." },
    { title: "Invitations", detail: `Single-use, stored only as a hash, and expire after ${inviteDays} day${inviteDays === 1 ? "" : "s"} (${INVITE_TTL_HOURS} hours). A new invitation revokes earlier pending ones for the same email.` },
    { title: "Sessions", detail: `Session tokens are stored hashed, last ${SESSION_TTL_DAYS} days, and can be revoked below or by an admin from the Team page. Removing a member signs them out everywhere.` },
    { title: "Passwords", detail: "Hashed with bcrypt. Clients are never asked for passwords to their own accounts; access requests use delegated access instructions." },
    { title: "Password reset", detail: "Single-use emailed links that expire after 60 minutes and are stored only as a hash. The form never reveals whether an account exists, and a reset signs the account out everywhere." },
    { title: "Two-step sign-in (MFA)", detail: `Authenticator-app codes (TOTP) with single-use recovery codes; each code works once. ${team.length ? `${withMfa} of ${team.length} team members have it on.` : ""}${auth.workspace.require_staff_mfa ? " Required for this team." : " Optional for this team."}` },
    { title: "Rate limiting", detail: "Sign-in and invitation acceptance attempts are rate limited per account and IP, shared across app instances through the database." },
    { title: "Audit logging", detail: "Settings, team, invitation, review, upload, reminder, automation, integration and import events are recorded with the actor and time." },
    {
      title: "Encrypted integration credentials",
      detail: `Integration secrets are encrypted at rest with AES-256-GCM and never shown again after saving.${usingFallbackKey() ? " This deployment uses a key derived from SESSION_SECRET; set INTEGRATION_ENCRYPTION_KEY." : ""}`,
    },
    { title: "Signed webhooks", detail: "Inbound CRM webhooks are rejected unless their signature (HubSpot v3, HMAC-SHA256) or basic-auth password matches the saved secret." },
    { title: "Configuration validation", detail: `Environment variables are validated at startup; production refuses to start without required secrets.${envCheck.problems.length ? ` Current warnings: ${envCheck.problems.join("; ")}.` : ""}` },
    { title: "Security headers", detail: "Pages are sent with X-Frame-Options: DENY, X-Content-Type-Options: nosniff and a same-origin referrer policy." },
  ];

  const conditional: Row[] = [
    scanner.configured
      ? { title: "Malware scanning", detail: "Uploads are scanned by ClamAV before they are stored. Infected files are refused." }
      : { title: "Malware scanning: not configured", detail: "File scanning integration not configured. Enable before handling sensitive production documents. Set CLAMAV_HOST to a clamd instance; until then uploads are type- and size-checked only." },
    { title: "Encryption of stored files", detail: "Files are not encrypted by the application itself. Use an encrypted disk or volume for STORAGE_DIR, and TLS in front of the app." },
  ];

  const notImplemented: Row[] = [
    { title: "Single sign-on (SSO / SAML)", detail: "Not available. Sign-in is email and password." },
    { title: "SMS, email codes or security keys", detail: "Two-step sign-in supports authenticator apps only. Passkeys and hardware security keys are not available." },
    { title: "Compliance certifications", detail: "ClientFlow has not been audited or certified for SOC 2, HIPAA, GDPR, ISO 27001 or similar. Don't represent it as compliant." },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <Card title="Implemented in this build" padded={false}>
          <List rows={implemented} icon="yes" />
        </Card>
        <Card title="Depends on your configuration" padded={false}>
          <List rows={conditional} icon="partial" />
        </Card>
        <Card title="Not implemented" padded={false}>
          <List rows={notImplemented} icon="no" />
        </Card>
      </div>
      <div className="min-w-0 space-y-6">
        <Card
          title="Your active sessions"
          padded={false}
          action={
            sessions.length > 1 ? (
              <ActionForm action={revokeMySessionAction} showSuccess={false}>
                <input type="hidden" name="sessionId" value="others" />
                <SubmitButton className="btn-secondary px-3 py-1 text-xs">Sign out others</SubmitButton>
              </ActionForm>
            ) : undefined
          }
        >
          <ul className="divide-y divide-ink-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {summarizeAgent(s.user_agent)} {s.id === auth.sessionId && <Badge tone="brand">This device</Badge>}
                  </p>
                  <p className="text-xs text-ink-500">Last active {formatDateTime(s.last_seen_at)} · expires {formatDateTime(s.expires_at)}</p>
                </div>
                {s.id !== auth.sessionId && (
                  <ActionForm action={revokeMySessionAction} showSuccess={false}>
                    <input type="hidden" name="sessionId" value={s.id} />
                    <SubmitButton className="btn-ghost px-2 py-1 text-xs">Revoke</SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Two-step sign-in" padded={false}>
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm text-ink-600">
              {auth.workspace.require_staff_mfa ? "Required for everyone on the team." : "Optional. Each person can turn it on from their account page."}
            </p>
            {isAdmin && (
              <ActionForm action={setRequireMfaAction}>
                <input type="hidden" name="on" value={auth.workspace.require_staff_mfa ? "false" : "true"} />
                <SubmitButton className="btn-secondary px-3 py-1.5 text-xs">{auth.workspace.require_staff_mfa ? "Make optional" : "Require for the team"}</SubmitButton>
              </ActionForm>
            )}
            <Link href="/account" className="inline-block text-sm font-medium text-brand-700 hover:underline">
              {auth.user.mfa_enabled ? "Manage yours" : "Set up yours"}
            </Link>
          </div>
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {team.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 px-5 py-2.5">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="truncate text-xs text-ink-500">{t.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge tone={t.mfa ? "success" : "neutral"}>{t.mfa ? "On" : "Off"}</Badge>
                  {isAdmin && t.mfa && t.id !== auth.user.id && (
                    <ActionForm action={resetMemberMfaAction} confirm={`Reset two-step sign-in for ${t.email}? They'll be signed out and must set it up again.`}>
                      <input type="hidden" name="userId" value={t.id} />
                      <SubmitButton className="btn-ghost px-2 py-1 text-xs" title="For a lost device">Reset</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="File scanning">
          <div className="flex items-center justify-between">
            <span className="text-sm">{scanner.configured ? "ClamAV" : "No scanner"}</span>
            <Badge tone={scannerVerified ? "success" : "warning"}>
              {!scanner.configured ? "Not configured" : scannerVerified ? "Connected" : lastTest ? "Test failed" : "Configuration Required"}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {!scanner.configured
              ? "File scanning integration not configured. Enable before handling sensitive production documents."
              : lastTest
                ? `Last test ${formatDateTime(lastTest.created_at)}: ${lastTest.metadata?.detail ?? ""}`
                : "Configured but not tested yet. Shows Connected only after a test detects the standard EICAR test file."}
          </p>
          {isAdmin && scanner.configured && (
            <ActionForm action={testScannerAction} className="mt-3">
              <SubmitButton className="btn-secondary px-3 py-1.5 text-xs" pendingText="Testing…">Test scanner</SubmitButton>
            </ActionForm>
          )}
          <div className="mt-4 border-t border-ink-100 pt-3">
            <p className="text-sm font-medium">Unscanned files</p>
            <p className="mt-0.5 text-xs text-ink-500">
              {auth.workspace.block_unscanned_uploads
                ? "Refused. Clients can't upload while no scanner is available."
                : "Accepted and marked \"Not scanned\" on every file."}
            </p>
            {isAdmin && (
              <ActionForm action={setBlockUnscannedAction} className="mt-2">
                <input type="hidden" name="on" value={auth.workspace.block_unscanned_uploads ? "false" : "true"} />
                <SubmitButton className="btn-secondary px-3 py-1.5 text-xs">
                  {auth.workspace.block_unscanned_uploads ? "Accept and flag instead" : "Refuse unscanned files"}
                </SubmitButton>
              </ActionForm>
            )}
          </div>
        </Card>
        <Notice tone="warning" title="No certifications">
          No SOC 2, HIPAA, GDPR or ISO certification is claimed. Review the <Link href="/app/settings/pilot-readiness" className="font-medium underline">pilot readiness</Link> page before a pilot with real client data.
        </Notice>
      </div>
    </div>
  );
}

function summarizeAgent(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}
