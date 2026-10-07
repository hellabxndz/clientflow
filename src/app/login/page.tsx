import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { ActionForm, SubmitButton } from "@/components/forms";
import { loginAction } from "../auth-actions";
import { Logo } from "@/components/logo";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; joined?: string }> }) {
  const sp = await searchParams;
  const auth = await getAuth();
  if (auth) redirect(auth.role === "client" ? "/portal" : "/app");
  const demo = process.env.SHOW_DEMO_LOGINS !== "false";
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="card p-6 sm:p-8">
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-ink-500">For team members and clients.</p>
          {sp.reset && <p role="status" className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Your password was changed. Sign in with the new one.</p>}
          {sp.joined && <p role="status" className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">You've joined the workspace. Sign in to continue.</p>}
          <ActionForm action={loginAction} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input" id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div>
              <div className="flex items-baseline justify-between">
                <label className="label" htmlFor="password">Password</label>
                <Link href="/forgot" className="text-xs font-medium text-brand-700 hover:underline">Forgot password?</Link>
              </div>
              <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <SubmitButton className="btn-primary w-full py-2.5" pendingText="Signing in…">Sign in</SubmitButton>
          </ActionForm>
        </div>
        {demo && (
          <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50/60 p-4 text-sm text-ink-700">
            <p className="font-semibold text-brand-800">Demo workspace logins</p>
            <p className="mt-1 text-ink-600">Fictional data. Password for all: <code className="rounded bg-white px-1">demo-password-123</code></p>
            <ul className="mt-2 space-y-1">
              <li><span className="font-medium">Admin:</span> olivia@northstar.example.com</li>
              <li><span className="font-medium">Manager:</span> marcus@northstar.example.com</li>
              <li><span className="font-medium">Account manager:</span> sarah@northstar.example.com</li>
              <li><span className="font-medium">Design lead:</span> priya@northstar.example.com</li>
              <li><span className="font-medium">Client:</span> john@johnsondental.example.com</li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
