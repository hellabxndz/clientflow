import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Logo } from "@/components/logo";
import { verifyMfaAction } from "../../auth-actions";

export const metadata = { title: "Two-step sign-in" };

export default function VerifyPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold">Enter your code</h1>
          <p className="mt-1 text-sm text-ink-500">Open your authenticator app and enter the 6-digit code for ClientFlow.</p>
          <ActionForm action={verifyMfaAction} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="code">Code</label>
              <input className="input text-center font-mono text-lg tracking-[0.3em]" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={14} />
              <p className="mt-1.5 text-xs text-ink-500">Lost your phone? Enter one of your recovery codes instead.</p>
            </div>
            <SubmitButton className="btn-primary w-full py-2.5" pendingText="Checking…">Verify and sign in</SubmitButton>
          </ActionForm>
        </div>
        <p className="mt-4 text-center text-sm text-ink-500">
          <Link href="/login" className="font-medium text-brand-700 hover:underline">Start over</Link>
        </p>
      </div>
    </main>
  );
}
