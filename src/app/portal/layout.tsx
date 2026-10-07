import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { requireClient } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { logoutAction } from "../auth-actions";
import { portalBrand } from "./brand";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireClient();
  const client = await withTenant(tenantCtx(auth), (tx) => tx.one<{ name: string }>("select name from clients where id = $1", [auth.clientId]));
  const ws = auth.workspace;
  const brand = portalBrand(ws);
  return (
    <div className="min-h-screen bg-ink-50" style={brand.style}>
      <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/95 backdrop-blur">
        <div className="h-1" style={{ background: "linear-gradient(90deg, var(--brand), var(--accent))" }} />
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/portal" className="flex min-w-0 items-center gap-3">
            {ws.logo_storage_key ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/api/branding/logo" alt={brand.name} className="h-9 w-auto max-w-[140px] object-contain" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: "var(--brand)" }} aria-hidden>
                {brand.monogram}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-900">{brand.name}</span>
              {client?.name && <span className="block truncate text-xs text-ink-500">{client.name}</span>}
            </span>
          </Link>
          <form action={logoutAction}>
            <button className="btn-ghost min-h-[40px] px-3 py-1.5 text-sm">Sign out</button>
          </form>
        </div>
      </header>
      {ws.is_demo && (
        <div className="bg-ink-900 px-4 py-1.5 text-center text-xs text-white">Demo portal with fictional data. Nothing you do here is emailed or sent anywhere.</div>
      )}
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-6 sm:pb-12 sm:pt-8">{children}</main>
      <footer className="mx-auto max-w-2xl space-y-2 px-4 pb-10 text-center text-xs text-ink-500">
        {(ws.support_email || ws.support_phone) && (
          <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <span>Need help?</span>
            {ws.support_email && (
              <a href={`mailto:${ws.support_email}`} className="inline-flex items-center gap-1 font-medium text-ink-700 hover:underline">
                <Mail className="h-3.5 w-3.5" /> {ws.support_email}
              </a>
            )}
            {ws.support_phone && (
              <a href={`tel:${ws.support_phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 font-medium text-ink-700 hover:underline">
                <Phone className="h-3.5 w-3.5" /> {ws.support_phone}
              </a>
            )}
          </p>
        )}
        <p className="text-ink-400">Your files are stored privately and only shared with {brand.company}. We'll never ask you for a password.</p>
      </footer>
    </div>
  );
}
