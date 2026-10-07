import Link from "next/link";
import { CheckCircle2, Settings2, XCircle } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { pilotReadiness, type ReadinessEntry } from "@/lib/pilot-readiness";
import { Notice } from "@/components/ui";

export const metadata = { title: "Pilot readiness" };

function Column({ title, hint, entries, tone }: { title: string; hint: string; entries: ReadinessEntry[]; tone: "working" | "configure" | "missing" }) {
  const Icon = tone === "working" ? CheckCircle2 : tone === "configure" ? Settings2 : XCircle;
  const color = tone === "working" ? "text-emerald-600" : tone === "configure" ? "text-amber-600" : "text-ink-400";
  const head = tone === "working" ? "border-emerald-200 bg-emerald-50/60" : tone === "configure" ? "border-amber-200 bg-amber-50/60" : "border-ink-200 bg-ink-50";
  return (
    <section className="card min-w-0 overflow-hidden">
      <div className={`border-b px-5 py-3.5 ${head}`}>
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wider text-ink-800">
          <Icon className={`h-4 w-4 ${color}`} aria-hidden /> {title} <span className="ml-auto font-normal text-ink-500">{entries.length}</span>
        </h2>
        <p className="mt-0.5 text-xs text-ink-500">{hint}</p>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-500">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {entries.map((e) => (
            <li key={e.title} className="px-5 py-3">
              <p className="text-sm font-medium text-ink-900">{e.href ? <Link href={e.href} className="hover:text-brand-700">{e.title}</Link> : e.title}</p>
              <p className="mt-0.5 text-sm text-ink-600">{e.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function PilotReadinessPage() {
  const auth = await requireStaff();
  const r = await withTenant(tenantCtx(auth), (tx) => pilotReadiness(tx, auth.workspace));
  return (
    <div className="space-y-6">
      <Notice>
        Computed now from this deployment&apos;s configuration and this workspace&apos;s data. Nothing here is a certification; use it to decide what to fix before a pilot with real clients.
        {auth.workspace.is_demo && " This is a demo workspace, so email is never sent and external services are never called from it."}
      </Notice>
      <div className="grid gap-6 lg:grid-cols-3">
        <Column title="Working" hint="Built and active in this deployment." entries={r.working} tone="working" />
        <Column title="Requires configuration" hint="Built, but switched off or not configured here." entries={r.configure} tone="configure" />
        <Column title="Not yet implemented" hint="Genuine gaps in this build." entries={r.missing} tone="missing" />
      </div>
    </div>
  );
}
