import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { logoutAction } from "../auth-actions";
import Link from "next/link";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireClient();
  const client = await withTenant(tenantCtx(auth), (tx) => tx.one<{ name: string }>("select name from clients where id = $1", [auth.clientId]));
  const ws = auth.workspace;
  const initials = ws.name.replace(/\(.*\)/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div className="min-h-screen bg-ink-50" style={{ ["--brand" as string]: ws.brand_color }}>
      <header className="border-b border-ink-200 bg-white">
        <div className="h-1" style={{ background: ws.brand_color }} />
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/portal" className="flex min-w-0 items-center gap-3">
            {ws.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ws.logo_url} alt={ws.name} className="h-8 w-auto max-w-[140px] object-contain" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: ws.brand_color }}>{initials}</span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{ws.name}</span>
              <span className="block truncate text-xs text-ink-500">{client?.name} onboarding</span>
            </span>
          </Link>
          <form action={logoutAction}>
            <button className="btn-ghost px-2.5 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>
      {ws.is_demo && (
        <div className="bg-ink-900 px-4 py-1.5 text-center text-xs text-white">Demo portal with fictional data. Nothing you do here is sent anywhere.</div>
      )}
      <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-center text-xs text-ink-400">
        Your files are stored privately and only shared with {ws.name}. We'll never ask you for passwords.
      </footer>
    </div>
  );
}
