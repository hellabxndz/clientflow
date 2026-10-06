import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { ActionForm, SubmitButton } from "@/components/forms";
import { loginAction } from "../auth-actions";
import { Logo } from "@/components/logo";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
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
          <ActionForm action={loginAction} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input" id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
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
              <li><span className="font-medium">Admin:</span> maya@northwind.example.com</li>
              <li><span className="font-medium">Staff:</span> jordan@northwind.example.com</li>
              <li><span className="font-medium">Client:</span> marcus@brightline.example.com</li>
              <li><span className="font-medium">Client:</span> elena@harborpine.example.com</li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
