import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { requireAuth, mfaSetupRequired } from "@/lib/session";
import { otpauthUri, pendingSecret, qrSvg, recoveryCodesLeft } from "@/lib/mfa";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, Notice } from "@/components/ui";
import { Logo } from "@/components/logo";
import { beginMfaAction, changePasswordAction, confirmMfaAction, disableMfaAction, regenerateCodesAction } from "./actions";
import { CodeForm } from "./forms";

export const metadata = { title: "Your account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const auth = await requireAuth();
  const sp = await searchParams;
  const required = mfaSetupRequired(auth);
  const secret = auth.user.mfa_enabled ? null : await pendingSecret(auth.user.id);
  const qr = secret ? await qrSvg(otpauthUri(secret, auth.user.email, auth.workspace.portal_name || "ClientFlow")) : null;
  const codesLeft = auth.user.mfa_enabled ? await recoveryCodesLeft(auth.user.id) : 0;
  const home = auth.role === "client" ? "/portal" : "/app";
  const workspaceRequires = auth.role !== "client" && auth.workspace.require_staff_mfa;

  return (
    <main className="min-h-screen px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <Logo />
          {!required && (
            <Link href={home} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back
            </Link>
          )}
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Your account</h1>
          <p className="mt-1 text-sm text-ink-500">{auth.user.name} · {auth.user.email}</p>
        </div>

        {(required || sp.required) && !auth.user.mfa_enabled && (
          <Notice tone="warning" title="Two-step sign-in is required">
            {auth.workspace.name} requires two-step sign-in for its team. Set it up below to continue.
          </Notice>
        )}

        <Card
          title="Two-step sign-in"
          action={auth.user.mfa_enabled ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>}
        >
          {auth.user.mfa_enabled ? (
            <div className="space-y-5">
              <p className="flex items-start gap-2 text-sm text-ink-700">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                Signing in asks for a code from your authenticator app after your password. {codesLeft} recovery code{codesLeft === 1 ? "" : "s"} left.
              </p>
              <div className="border-t border-ink-100 pt-4">
                <p className="text-sm font-medium">New recovery codes</p>
                <p className="mb-3 text-sm text-ink-500">Replaces your current codes.</p>
                <CodeForm action={regenerateCodesAction} label="Current code from your app" button="Create new codes" pending="Creating…" />
              </div>
              {!workspaceRequires && (
                <div className="border-t border-ink-100 pt-4">
                  <p className="text-sm font-medium">Turn off</p>
                  <ActionForm action={disableMfaAction} className="mt-2 flex flex-wrap items-end gap-2">
                    <div>
                      <label className="label" htmlFor="off-password">Your password</label>
                      <input id="off-password" name="password" type="password" className="input" autoComplete="current-password" required />
                    </div>
                    <SubmitButton className="btn-secondary" pendingText="Turning off…">Turn off two-step sign-in</SubmitButton>
                  </ActionForm>
                </div>
              )}
            </div>
          ) : secret && qr ? (
            <div className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-700">
                <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
                <li>Scan this code, or enter the key by hand.</li>
                <li>Type the 6-digit code it shows.</li>
              </ol>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="h-44 w-44 shrink-0 rounded-lg border border-ink-200 bg-white p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qr }} />
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Key</p>
                  <p className="mt-1 break-all font-mono text-sm">{secret.match(/.{1,4}/g)?.join(" ")}</p>
                </div>
              </div>
              <CodeForm action={confirmMfaAction} label="Code from your app" button="Turn on two-step sign-in" pending="Checking…" done="Continue" />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-700">Add a code from an authenticator app to every sign-in, so a stolen password isn't enough to get in.</p>
              <form action={beginMfaAction}>
                <SubmitButton pendingText="Preparing…">Set up two-step sign-in</SubmitButton>
              </form>
            </div>
          )}
        </Card>

        <Card title="Password">
          <ActionForm action={changePasswordAction} className="grid gap-3 sm:max-w-sm" resetOnSuccess>
            <div>
              <label className="label" htmlFor="current">Current password</label>
              <input id="current" name="current" type="password" className="input" autoComplete="current-password" required />
            </div>
            <div>
              <label className="label" htmlFor="new-password">New password</label>
              <input id="new-password" name="password" type="password" className="input" autoComplete="new-password" minLength={10} required />
            </div>
            <div>
              <label className="label" htmlFor="confirm">Repeat new password</label>
              <input id="confirm" name="confirm" type="password" className="input" autoComplete="new-password" minLength={10} required />
            </div>
            <SubmitButton className="btn-primary w-fit" pendingText="Saving…">Change password</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </main>
  );
}
