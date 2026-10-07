import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { COMMON_TIMEZONES, WEEKDAY_LABEL } from "@/lib/time";
import { runRetentionNowAction, updatePolicyAction } from "../actions";
import { updateCompanyAction } from "./actions";

export const metadata = { title: "Company settings" };

const hourLabel = (h: number) => (h === 0 || h === 24 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);

export default async function CompanySettings() {
  const auth = await requireStaff();
  const ws = auth.workspace;
  const admin = auth.role === "admin";
  const zones = COMMON_TIMEZONES.includes(ws.timezone) ? COMMON_TIMEZONES : [ws.timezone, ...COMMON_TIMEZONES];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {!admin && <Notice className="lg:col-span-3">Only workspace admins can change company settings. Branding can be edited by managers.</Notice>}
      <div className="space-y-6 lg:col-span-2">
        <Card title="Company information">
          <ActionForm action={updateCompanyAction} className="space-y-5">
            <fieldset disabled={!admin} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="name">Company name</label>
                  <input id="name" name="name" className="input" defaultValue={ws.name} maxLength={120} required />
                </div>
                <div>
                  <label className="label" htmlFor="timezone">Time zone</label>
                  <select id="timezone" name="timezone" className="input" defaultValue={ws.timezone}>
                    {zones.map((tz) => <option key={tz}>{tz}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <p className="label">Business days</p>
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                    <label key={d} className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50">
                      <input type="checkbox" name="businessDays" value={d} defaultChecked={ws.business_days.includes(d)} className="h-4 w-4 rounded" />
                      {WEEKDAY_LABEL[d]}
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-500">Used for kickoff dates and for reminders set to business days only.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="label" htmlFor="businessStartHour">Business hours start</label>
                  <select id="businessStartHour" name="businessStartHour" className="input" defaultValue={ws.business_start_hour}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="businessEndHour">Business hours end</label>
                  <select id="businessEndHour" name="businessEndHour" className="input" defaultValue={ws.business_end_hour}>
                    {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="kickoffLeadDays">Kickoff lead time</label>
                  <div className="flex items-center gap-2">
                    <input id="kickoffLeadDays" name="kickoffLeadDays" type="number" min={0} max={30} className="input w-24" defaultValue={ws.kickoff_lead_days} />
                    <span className="text-sm text-ink-500">business days</span>
                  </div>
                </div>
              </div>
              <p className="-mt-2 text-xs text-ink-500">
                Kickoff is projected this many business days after a client becomes Ready for Kickoff. Reminders are never sent after business hours end or after 8pm in the client&apos;s time zone.
              </p>
              <div className="sm:w-1/2">
                <label className="label" htmlFor="maxUploadMb">Upload limit per file (MB)</label>
                <input id="maxUploadMb" name="maxUploadMb" type="number" min={1} max={100} className="input" defaultValue={ws.max_upload_mb} />
              </div>
              {admin && <SubmitButton pendingText="Saving…">Save company information</SubmitButton>}
            </fieldset>
          </ActionForm>
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Permissions and retention">
          <ActionForm action={updatePolicyAction} className="space-y-4">
            <fieldset disabled={!admin} className="space-y-4">
              <div>
                <label className="label" htmlFor="templateEditRole">Who can create and edit templates</label>
                <select id="templateEditRole" name="templateEditRole" className="input" defaultValue={ws.template_edit_role}>
                  <option value="admin">Admins and managers only</option>
                  <option value="staff">All staff</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="retentionDays">Delete stored files after completion</label>
                <div className="flex items-center gap-2">
                  <input id="retentionDays" name="retentionDays" type="number" min={30} className="input w-28" defaultValue={ws.retention_days ?? ""} placeholder="Keep" />
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
        <Card title="Next steps">
          <ul className="space-y-2 text-sm">
            <li><Link className="link" href="/app/settings/branding">Branding and client portal</Link></li>
            <li><Link className="link" href="/app/settings/team">Invite your team</Link></li>
            <li><Link className="link" href="/app/settings/launch">Launch checklist</Link></li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
