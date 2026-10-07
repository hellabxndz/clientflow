import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Logo } from "@/components/logo";
import { lookupReset } from "@/lib/password-reset";
import { resetPasswordAction } from "../../auth-actions";

export const metadata = { title: "Choose a new password" };

const REASONS = {
  invalid: "This reset link isn't valid.",
  expired: "This reset link has expired.",
  used: "This reset link was already used, or a newer one was requested.",
};

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await lookupReset(token);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="card p-6 sm:p-8">
          {state.ok ? (
            <>
              <h1 className="text-xl font-semibold">Choose a new password</h1>
              <p className="mt-1 text-sm text-ink-500">For {state.email}. You'll be signed out on every device.</p>
              <ActionForm action={resetPasswordAction} className="mt-6 space-y-4">
                <input type="hidden" name="token" value={token} />
                <div>
                  <label className="label" htmlFor="password">New password</label>
                  <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
                  <p className="mt-1 text-xs text-ink-500">At least 10 characters.</p>
                </div>
                <div>
                  <label className="label" htmlFor="confirm">Repeat it</label>
                  <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
                </div>
                <SubmitButton className="btn-primary w-full py-2.5" pendingText="Saving…">Save new password</SubmitButton>
              </ActionForm>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">{REASONS[state.reason]}</h1>
              <p className="mt-2 text-sm text-ink-600">
                <Link href="/forgot" className="font-medium text-brand-700 hover:underline">Request a new link</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
