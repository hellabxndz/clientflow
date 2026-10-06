"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/forms";
import { CopyLink } from "@/components/copy-link";
import { inviteContactAction } from "../../actions";

export function InviteContactForm({ clientId, defaultEmail }: { clientId: string; defaultEmail: string }) {
  const [state, action] = useActionState(inviteContactAction, null);
  const data = state?.data as { inviteUrl: string; emailStatus?: string } | undefined;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="clientId" value={clientId} />
      <label className="label" htmlFor="invite-email">Invite a contact</label>
      <div className="flex gap-2">
        <input id="invite-email" name="email" type="email" className="input" defaultValue={defaultEmail} placeholder="name@company.com" required />
        <SubmitButton className="btn-secondary shrink-0" pendingText="…">Invite</SubmitButton>
      </div>
      {state?.error && <p className="text-sm text-rose-700">{state.error}</p>}
      {data?.inviteUrl && (
        <div className="space-y-1.5 pt-1">
          <p className="text-xs text-ink-600">
            {data.emailStatus === "sent" ? "Emailed." : data.emailStatus === "simulated" ? "Demo: email recorded, not sent." : "Email not configured."} Single-use link, valid 7 days:
          </p>
          <CopyLink url={data.inviteUrl} />
        </div>
      )}
    </form>
  );
}
