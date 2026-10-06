"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/forms";
import { CopyLink } from "@/components/copy-link";
import { inviteStaffAction } from "../../actions";

export function InviteStaffForm({ isDemo }: { isDemo: boolean }) {
  const [state, action] = useActionState(inviteStaffAction, null);
  const data = state?.data as { inviteUrl: string; emailStatus?: string } | undefined;
  return (
    <form action={action} className="space-y-3">
      <div>
        <label className="label" htmlFor="staff-email">Email</label>
        <input id="staff-email" name="email" type="email" className="input" required />
      </div>
      <div>
        <label className="label" htmlFor="staff-role">Role</label>
        <select id="staff-role" name="role" className="input">
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <SubmitButton pendingText="Inviting…">Send invitation</SubmitButton>
      <p className="text-xs text-ink-500">Links are single-use and expire after 7 days.{isDemo ? " Demo workspace: emails are recorded, not sent." : ""}</p>
      {state?.error && <p className="text-sm text-rose-700">{state.error}</p>}
      {data?.inviteUrl && (
        <div className="space-y-1.5">
          <p className="text-sm text-emerald-700">{state?.ok}</p>
          <CopyLink url={data.inviteUrl} />
        </div>
      )}
    </form>
  );
}
