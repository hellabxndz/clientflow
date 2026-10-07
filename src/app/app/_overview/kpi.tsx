import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";

const TONE = {
  neutral: "text-ink-900",
  brand: "text-brand-700",
  warning: "text-amber-700",
  danger: "text-rose-700",
  success: "text-emerald-700",
  info: "text-sky-700",
} as const;

/** KPI tile. Every tile links to the list where the number can be acted on. */
export function Kpi({ label, value, hint, href, tone = "neutral", icon }: { label: string; value: ReactNode; hint?: ReactNode; href: string; tone?: keyof typeof TONE; icon?: ReactNode }) {
  return (
    <Link href={href} className="group block min-w-0 rounded-xl border border-ink-200 bg-white p-4 shadow-sm transition hover:border-brand-200 hover:shadow-md sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</p>
        {icon && <span className="shrink-0 text-ink-300 transition group-hover:text-brand-500">{icon}</span>}
      </div>
      <p className={clsx("mt-2 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl", TONE[tone])}>{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-ink-500">{hint}</p>}
    </Link>
  );
}
