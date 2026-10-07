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

  const implemented: Row[] = [
    { title: "Tenant isolation with row-level security", detail: "Tenant data is queried as a restricted database role. Postgres row-level security scopes every row to this workspace and, for client users, to their own company. Clients can't see internal tasks or internal notes." },
    { title: "Server-side authorization", detail: "Every server action checks the signed-in user's role (Admin, Manager, Staff, Client) before doing anything. Hiding a button is never the only protection." },
    { title: "Private file storage with expiring links", detail: `Files are stored privately (${getStorage().name}), never served from a public folder, and downloaded through links bound to the signed-in user that expire after ${DOWNLOAD_LINK_TTL_SECONDS / 60} minutes.` },
    { title: "Upload checks", detail: "File type allow-lists per request, a blocked list of executable types, content (magic byte) checks for common formats, and a per-workspace size limit." },
    { title: "Invitations", detail: `Single-use, stored only as a hash, and expire after ${inviteDays} day${inviteDays === 1 ? "" : "s"} (${INVITE_TTL_HOURS} hours). A new invitation revokes earlier pending ones for the same email.` },
    { title: "Sessions", detail: `Session tokens are stored hashed, last ${SESSION_TTL_DAYS} days, and can be revoked below or by an admin from the Team page. Removing a member signs them out everywhere.` },
    { title: "Passwords", detail: "Hashed with bcrypt. Clients are never asked for passwords to their own accounts; access requests use delegated access instructions." },
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
    { title: "Multi-factor authentication", detail: "Not available in this build." },
    { title: "Self-service password reset", detail: "Not available. An admin can remove and re-invite a team member." },
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
        <Card title="File scanning">
          <div className="flex items-center justify-between">
            <span className="text-sm">{scanner.configured ? "ClamAV" : "No scanner"}</span>
            <Badge tone={scanner.configured ? "success" : "warning"}>{scanner.configured ? "Connected" : "Not configured"}</Badge>
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
