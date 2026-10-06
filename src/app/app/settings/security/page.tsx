import { requireStaff } from "@/lib/session";
import { listSessions, INVITE_TTL_HOURS, SESSION_TTL_DAYS } from "@/lib/auth";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { getScanner } from "@/lib/scanning";
import { getStorage } from "@/lib/storage";
import { DOWNLOAD_LINK_TTL_SECONDS } from "@/lib/files";
import { revokeMySessionAction } from "../../actions";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const auth = await requireStaff();
  const sessions = await listSessions(auth.user.id);
  const scanner = getScanner();
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Your active sessions" padded={false} action={sessions.length > 1 ? (
          <ActionForm action={revokeMySessionAction} showSuccess={false}>
            <input type="hidden" name="sessionId" value="others" />
            <SubmitButton className="btn-secondary px-3 py-1 text-xs">Sign out other sessions</SubmitButton>
          </ActionForm>
        ) : undefined}>
          <ul className="divide-y divide-ink-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">{summarizeAgent(s.user_agent)} {s.id === auth.sessionId && <Badge tone="brand">This device</Badge>}</p>
                  <p className="text-xs text-ink-500">Signed in {formatDateTime(s.created_at)} · last active {formatDateTime(s.last_seen_at)} · expires {formatDateTime(s.expires_at)}</p>
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
        <Card title="How access is enforced">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-600">
            <li>Every server action checks the signed-in role. Tenant data is queried as a restricted database role with Postgres row-level security, scoped to this workspace and, for clients, to their own company.</li>
            <li>Clients can't see internal tasks or internal notes; the database hides those rows from client sessions.</li>
            <li>Sessions last {SESSION_TTL_DAYS} days, are stored hashed, and can be revoked here or by an admin from the Team page.</li>
            <li>Invitations are single-use, stored hashed, and expire after {Math.round(INVITE_TTL_HOURS / 24)} days.</li>
            <li>Files are stored privately ({getStorage().name}) and downloaded through links bound to the signed-in user that expire after {DOWNLOAD_LINK_TTL_SECONDS / 60} minutes.</li>
          </ul>
        </Card>
      </div>
      <div className="space-y-6">
        <Card title="File scanning">
          <div className="flex items-center justify-between">
            <span className="text-sm">{scanner.configured ? "ClamAV" : "No scanner"}</span>
            <Badge tone={scanner.configured ? "success" : "warning"}>{scanner.configured ? "Connected" : "Missing"}</Badge>
          </div>
          {!scanner.configured && (
            <p className="mt-2 text-sm text-ink-600">Uploads are type- and size-checked but not malware-scanned. Set CLAMAV_HOST before collecting sensitive documents from real clients.</p>
          )}
        </Card>
        <Notice tone="warning" title="Not certified">
          ClientFlow has not been audited for SOC 2, HIPAA or similar standards. Review the setup checklist in the README before a pilot with real client data.
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
