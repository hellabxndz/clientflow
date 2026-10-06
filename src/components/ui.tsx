import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";
import { STAGE_LABEL, STATUS_LABEL, TASK_STATUS_LABEL, type ItemStatus, type Stage } from "@/lib/onboarding";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-[15px] text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, title, action, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; padded?: boolean }) {
  return (
    <section className={clsx("card", className)}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
          {action}
        </div>
      )}
      <div className={clsx(padded && "p-5")}>{children}</div>
    </section>
  );
}

const STATUS_STYLE: Record<ItemStatus, string> = {
  not_started: "bg-ink-100 text-ink-600 ring-ink-200",
  in_progress: "bg-sky-50 text-sky-700 ring-sky-200",
  submitted: "bg-amber-50 text-amber-800 ring-amber-200",
  changes_requested: "bg-rose-50 text-rose-700 ring-rose-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};

export function StatusBadge({ status, task = false, className }: { status: ItemStatus; task?: boolean; className?: string }) {
  return (
    <span className={clsx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_STYLE[status], className)}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", status === "approved" ? "bg-emerald-500" : status === "changes_requested" ? "bg-rose-500" : status === "submitted" ? "bg-amber-500" : status === "in_progress" ? "bg-sky-500" : "bg-ink-400")} />
      {task ? TASK_STATUS_LABEL[status] : STATUS_LABEL[status]}
    </span>
  );
}

const STAGE_STYLE: Record<Stage, string> = {
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ready: "bg-brand-50 text-brand-700 ring-brand-200",
  review: "bg-amber-50 text-amber-800 ring-amber-200",
  waiting_client: "bg-sky-50 text-sky-700 ring-sky-200",
  internal: "bg-ink-100 text-ink-700 ring-ink-200",
  paused: "bg-ink-100 text-ink-500 ring-ink-200",
  cancelled: "bg-ink-100 text-ink-400 ring-ink-200",
};

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className={clsx("inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", STAGE_STYLE[stage])}>
      {STAGE_LABEL[stage]}
    </span>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "brand" | "warning" | "danger" | "success" | "info"; className?: string }) {
  const tones = {
    neutral: "bg-ink-100 text-ink-600 ring-ink-200",
    brand: "bg-brand-50 text-brand-700 ring-brand-200",
    warning: "bg-amber-50 text-amber-800 ring-amber-200",
    danger: "bg-rose-50 text-rose-700 ring-rose-200",
    success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    info: "bg-sky-50 text-sky-700 ring-sky-200",
  };
  return <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>{children}</span>;
}

export function Progress({ value, className, color }: { value: number; className?: string; color?: string }) {
  return (
    <div className={clsx("h-2 w-full overflow-hidden rounded-full bg-ink-100", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  );
}

export function Avatar({ name, size = "sm", color }: { name: string; size?: "sm" | "md"; color?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800", size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm")}
      style={color ? { background: color, color: "#fff" } : undefined}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-200 bg-white px-6 py-12 text-center">
      <p className="font-medium text-ink-800">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "warning" | "brand" | "success" }) {
  const body = (
    <div className={clsx("card h-full p-5 transition", href && "hover:border-brand-200 hover:shadow-md")}>
      <p className="text-sm font-medium text-ink-500">{label}</p>
      <p className={clsx("mt-2 text-3xl font-semibold tracking-tight", tone === "warning" ? "text-amber-700" : tone === "brand" ? "text-brand-700" : tone === "success" ? "text-emerald-700" : "text-ink-900")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Notice({ tone = "info", title, children, className }: { tone?: "info" | "warning" | "danger" | "success"; title?: string; children: ReactNode; className?: string }) {
  const tones = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-rose-200 bg-rose-50 text-rose-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  return (
    <div className={clsx("rounded-lg border px-4 py-3 text-sm", tones[tone], className)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={clsx(title && "mt-0.5")}>{children}</div>
    </div>
  );
}

export function Tabs({ tabs, active }: { tabs: { href: string; label: string; key: string }[]; active: string }) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-ink-200">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={clsx(
            "whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition",
            t.key === active ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-800",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
