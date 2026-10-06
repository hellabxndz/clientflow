import { lookupInvitation } from "@/lib/auth";
import { ActionForm, SubmitButton } from "@/components/forms";
import { acceptInviteAction } from "../../auth-actions";
import Link from "next/link";

export const metadata = { title: "Accept invitation" };

const REASONS = {
  invalid: "This invitation link isn't valid. Check that you copied the whole link.",
  expired: "This invitation has expired. Ask the person who invited you to send a new one.",
  used: "This invitation has already been used. Sign in instead.",
  revoked: "This invitation was cancelled. Ask for a new one if you still need access.",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await lookupInvitation(token);
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {!state.ok ? (
          <div className="card p-8 text-center">
            <h1 className="text-xl font-semibold">Invitation unavailable</h1>
            <p className="mt-2 text-ink-600">{REASONS[state.reason]}</p>
            <Link href="/login" className="btn-secondary mt-6">Go to sign in</Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="h-2" style={{ background: state.invitation.brand_color }} />
            <div className="p-6 sm:p-8">
              <p className="text-sm font-medium" style={{ color: state.invitation.brand_color }}>{state.invitation.workspace_name}</p>
              <h1 className="mt-1 text-xl font-semibold">
                {state.invitation.role === "client" ? `Set up your ${state.invitation.client_name} portal access` : "Join the team workspace"}
              </h1>
              <p className="mt-2 text-sm text-ink-500">
                Invitation for <span className="font-medium text-ink-700">{state.invitation.email}</span>. Expires{" "}
                {new Date(state.invitation.expires_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
              </p>
              <ActionForm action={acceptInviteAction} className="mt-6 space-y-4">
                <input type="hidden" name="token" value={token} />
                {!state.invitation.user_exists && (
                  <div>
                    <label className="label" htmlFor="name">Your name</label>
                    <input className="input" id="name" name="name" autoComplete="name" required />
                  </div>
                )}
                <div>
                  <label className="label" htmlFor="password">{state.invitation.user_exists ? "Your existing password" : "Create a password"}</label>
                  <input className="input" id="password" name="password" type="password" autoComplete={state.invitation.user_exists ? "current-password" : "new-password"} minLength={state.invitation.user_exists ? undefined : 10} required />
                  {!state.invitation.user_exists && <p className="mt-1 text-xs text-ink-500">At least 10 characters.</p>}
                </div>
                <SubmitButton className="btn-primary w-full py-2.5" pendingText="Joining…">Accept invitation</SubmitButton>
              </ActionForm>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
