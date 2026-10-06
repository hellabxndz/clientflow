import { requireStaff } from "@/lib/session";
import { Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { COMMON_TIMEZONES } from "@/lib/time";
import { runRetentionNowAction, updatePolicyAction, updateWorkspaceAction } from "../actions";

export const metadata = { title: "Settings" };

export default async function GeneralSettings() {
  const auth = await requireStaff();
  const ws = auth.workspace;
  const admin = auth.role === "admin";
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {!admin && <Notice className="lg:col-span-2">Only workspace admins can change these settings.</Notice>}
      <Card title="Workspace and branding">
        <ActionForm action={updateWorkspaceAction} className="space-y-4">
          <fieldset disabled={!admin} className="space-y-4">
            <div>
              <label className="label" htmlFor="name">Workspace name</label>
              <input id="name" name="name" className="input" defaultValue={ws.name} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="brandColor">Brand color</label>
                <div className="flex gap-2">
                  <span className="h-10 w-10 shrink-0 rounded-lg border border-ink-200" style={{ background: ws.brand_color }} aria-hidden />
                  <input id="brandColor" name="brandColor" className="input font-mono" defaultValue={ws.brand_color} pattern="#[0-9a-fA-F]{6}" />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="timezone">Default time zone</label>
                <select id="timezone" name="timezone" className="input" defaultValue={ws.timezone}>
                  {COMMON_TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="logoUrl">Logo URL</label>
              <input id="logoUrl" name="logoUrl" className="input" defaultValue={ws.logo_url ?? ""} placeholder="https://…" />
              <p className="mt-1 text-xs text-ink-500">Shown in the client portal header. Leave blank to show your workspace initials.</p>
            </div>
            <div>
              <label className="label" htmlFor="portalWelcome">Portal welcome message</label>
              <textarea id="portalWelcome" name="portalWelcome" className="input min-h-[80px]" defaultValue={ws.portal_welcome} maxLength={600} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="emailFromName">Email sender name</label>
                <input id="emailFromName" name="emailFromName" className="input" defaultValue={ws.email_from_name ?? ""} />
              </div>
              <div>
                <label className="label" htmlFor="maxUploadMb">Upload limit (MB)</label>
                <input id="maxUploadMb" name="maxUploadMb" type="number" min={1} max={100} className="input" defaultValue={ws.max_upload_mb} />
              </div>
            </div>
            {admin && <SubmitButton>Save</SubmitButton>}
          </fieldset>
        </ActionForm>
      </Card>

      <div className="space-y-6">
        <Card title="Permissions and retention">
          <ActionForm action={updatePolicyAction} className="space-y-4">
            <fieldset disabled={!admin} className="space-y-4">
              <div>
                <label className="label" htmlFor="templateEditRole">Who can create and edit templates</label>
                <select id="templateEditRole" name="templateEditRole" className="input" defaultValue={ws.template_edit_role}>
                  <option value="admin">Admins only</option>
                  <option value="staff">All staff</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="retentionDays">Delete stored files after completion</label>
                <div className="flex items-center gap-2">
                  <input id="retentionDays" name="retentionDays" type="number" min={30} className="input w-32" defaultValue={ws.retention_days ?? ""} placeholder="Keep" />
                  <span className="text-sm text-ink-500">days (blank keeps files)</span>
                </div>
                <p className="mt-1 text-xs text-ink-500">Applies to completed or cancelled onboardings. File names, hashes and review history stay in the audit trail.</p>
              </div>
              {admin && <SubmitButton>Save</SubmitButton>}
            </fieldset>
          </ActionForm>
          {admin && ws.retention_days && (
            <ActionForm action={runRetentionNowAction} className="mt-4 border-t border-ink-100 pt-4" confirm="Permanently delete stored files that are past the retention period?">
              <SubmitButton className="btn-secondary" pendingText="Running…">Run retention now</SubmitButton>
            </ActionForm>
          )}
        </Card>
        <Card title="Client portal preview">
          <div className="overflow-hidden rounded-lg border border-ink-200">
            <div className="h-1.5" style={{ background: ws.brand_color }} />
            <div className="p-4">
              <p className="text-sm font-semibold" style={{ color: ws.brand_color }}>{ws.name}</p>
              <p className="mt-1 text-sm text-ink-600">{ws.portal_welcome}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
