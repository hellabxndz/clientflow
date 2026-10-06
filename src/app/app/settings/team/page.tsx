import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Avatar, Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate } from "@/lib/time";
import { removeMemberAction, revokeInvitationAction, revokeMemberSessionsAction, updateMemberAction } from "../../actions";
import { InviteStaffForm } from "./invite-staff";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const auth = await requireStaff();
  const admin = auth.role === "admin";
  const data = await withTenant(tenantCtx(auth), async (tx) => ({
    members: await tx.q<{ id: string; user_id: string; name: string; email: string; role: string; can_approve: boolean }>(
      `select m.id, m.user_id, u.name, u.email, m.role, m.can_approve from memberships m join users u on u.id = m.user_id
       where m.role in ('admin','staff') order by m.role, u.name`,
    ),
    invites: await tx.q<{ id: string; email: string; role: string; expires_at: Date; expired: boolean; client_name: string | null }>(
      `select i.id, i.email, i.role, i.expires_at, i.expires_at < now() as expired, c.name as client_name
       from invitations i left join clients c on c.id = i.client_id where i.accepted_at is null and i.revoked_at is null order by i.created_at desc`,
    ),
  }));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="Team members" padded={false}>
          <ul className="divide-y divide-ink-100">
            {data.members.map((m) => (
              <li key={m.id} className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar name={m.name} size="md" />
                  <div className="min-w-0">
                    <p className="font-medium">{m.name}{m.user_id === auth.user.id && <span className="ml-1 text-xs text-ink-400">(you)</span>}</p>
                    <p className="truncate text-sm text-ink-500">{m.email}</p>
                  </div>
                </div>
                {admin ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <ActionForm action={updateMemberAction} className="flex flex-wrap items-center gap-2" showSuccess={false}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <select name="role" defaultValue={m.role} className="input w-auto py-1.5 text-sm" aria-label="Role">
                        <option value="admin">Admin</option>
                        <option value="staff">Staff</option>
                      </select>
                      <label className="flex items-center gap-1.5 text-xs" title="Can approve onboarding completion">
                        <input type="checkbox" name="canApprove" defaultChecked={m.can_approve || m.role === "admin"} className="h-4 w-4 rounded" /> Can approve
                      </label>
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs">Save</SubmitButton>
                    </ActionForm>
                    <ActionForm action={revokeMemberSessionsAction} showSuccess={false} confirm={`Sign ${m.name} out of every device?`}>
                      <input type="hidden" name="memberId" value={m.id} />
                      <SubmitButton className="btn-ghost px-2 py-1 text-xs">Sign out everywhere</SubmitButton>
                    </ActionForm>
                    {m.user_id !== auth.user.id && (
                      <ActionForm action={removeMemberAction} showSuccess={false} confirm={`Remove ${m.name} from the workspace?`}>
                        <input type="hidden" name="memberId" value={m.id} />
                        <SubmitButton className="btn-ghost px-2 py-1 text-xs text-rose-700">Remove</SubmitButton>
                      </ActionForm>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-1">
                    <Badge tone={m.role === "admin" ? "brand" : "neutral"}>{m.role}</Badge>
                    {(m.can_approve || m.role === "admin") && <Badge tone="success">Can approve</Badge>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Pending invitations" padded={false}>
          {data.invites.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-500">No pending invitations.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {data.invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{i.email}</p>
                    <p className="text-xs text-ink-500">
                      {i.role === "client" ? `Client contact for ${i.client_name}` : i.role} · {i.expired ? <span className="text-rose-700">expired {formatDate(i.expires_at)}</span> : `expires ${formatDate(i.expires_at)}`}
                    </p>
                  </div>
                  <ActionForm action={revokeInvitationAction} showSuccess={false}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <SubmitButton className="btn-ghost px-2 py-1 text-xs">Revoke</SubmitButton>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        {admin ? (
          <Card title="Invite a team member">
            <InviteStaffForm isDemo={auth.workspace.is_demo} />
          </Card>
        ) : (
          <Notice>Only admins can invite team members.</Notice>
        )}
        <Card title="Roles">
          <ul className="space-y-2 text-sm text-ink-600">
            <li><span className="font-medium text-ink-800">Admin:</span> everything, including settings, team, reminders and completion approval.</li>
            <li><span className="font-medium text-ink-800">Staff:</span> clients, reviews, tasks and documents. Completion approval only if granted.</li>
            <li><span className="font-medium text-ink-800">Client:</span> their own company's portal only.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
