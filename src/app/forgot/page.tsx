import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Logo } from "@/components/logo";
import { requestResetAction } from "../auth-actions";

export const metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold">Reset your password</h1>
          <p className="mt-1 text-sm text-ink-500">We'll email you a link to choose a new one. The link works once, for 60 minutes.</p>
          <ActionForm action={requestResetAction} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input" id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <SubmitButton className="btn-primary w-full py-2.5" pendingText="Sending…">Email me a link</SubmitButton>
          </ActionForm>
        </div>
        <p className="mt-4 text-center text-sm text-ink-500">
          <Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
