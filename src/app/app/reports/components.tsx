import clsx from "clsx";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";

export const NOT_ENOUGH = "Not enough data yet";

export function formatHours(h: number) {
  return h >= 48 ? `${Math.round((h / 24) * 10) / 10} days` : `${h} h`;
}

export type Unit = "days" | "hours" | "percent" | "count";

export function formatValue(v: number, unit: Unit) {
  if (unit === "days") return `${v} day${v === 1 ? "" : "s"}`;
  if (unit === "hours") return formatHours(v);
  if (unit === "percent") return `${v}%`;
  return v.toLocaleString("en-US");
}

function formatDelta(d: number, unit: Unit) {
  const a = Math.round(Math.abs(d) * 10) / 10;
  if (unit === "days") return `${a} day${a === 1 ? "" : "s"}`;
  if (unit === "hours") return formatHours(a);
  if (unit === "percent") return `${a} pts`;
  return a.toLocaleString("en-US");
}

/** Change against the previous period. Neutral wording and color: whether a change is good depends on context. */
export function Delta({ current, previous, unit, periodLabel }: { current: number | null; previous: number | null; unit: Unit; periodLabel: string }) {
  if (current == null || previous == null) return <span className="text-ink-400">No comparison for the previous {periodLabel}</span>;
  const d = current - previous;
  if (Math.abs(d) < 0.05)
    return (
      <span className="inline-flex items-center gap-1 text-ink-500">
        <ArrowRight className="h-3.5 w-3.5" aria-hidden /> Same as previous {periodLabel}
      </span>
    );
  const Icon = d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-ink-600">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {d > 0 ? "Up" : "Down"} {formatDelta(d, unit)} vs previous {periodLabel} ({formatValue(previous, unit)})
    </span>
  );
}

export function MetricTile({
  label,
  value,
  previous,
  unit,
  periodLabel,
  hint,
  href,
}: {
  label: string;
  value: number | null;
  previous: number | null;
  unit: Unit;
  periodLabel: string;
  hint?: ReactNode;
  href?: string;
}) {
  const body = (
    <div className={clsx("card flex h-full flex-col p-5 transition", href && "hover:border-brand-200 hover:shadow-md")}>
      <p className="text-sm font-medium text-ink-500">{label}</p>
      {value == null ? (
        <p className="mt-2 text-base font-medium text-ink-400">{NOT_ENOUGH}</p>
      ) : (
        <p className="mt-2 text-3xl font-semibold tracking-tight text-ink-900 tabular-nums">{formatValue(value, unit)}</p>
      )}
      <div className="mt-auto space-y-0.5 pt-2 text-xs">
        <Delta current={value} previous={previous} unit={unit} periodLabel={periodLabel} />
        {hint && <p className="text-ink-400">{hint}</p>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Bar chart of average readiness at each point; empty points have no active onboardings. */
export function TrendChart({ points }: { points: { date: Date; avg: number | null; onboardings: number }[] }) {
  const w = 640;
  const h = 200;
  const pad = { l: 34, r: 8, t: 12, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const slot = innerW / Math.max(1, points.length);
  const barW = Math.min(36, slot * 0.6);
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label="Average readiness of active onboardings over time">
      {[0, 50, 100].map((g) => {
        const y = pad.t + innerH - (g / 100) * innerH;
        return (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={y} y2={y} stroke="#ebe8f0" strokeDasharray={g === 0 ? undefined : "3 3"} />
            <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#8a8597">{g}%</text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const x = pad.l + slot * i + (slot - barW) / 2;
        const bh = p.avg == null ? 0 : (p.avg / 100) * innerH;
        const showLabel = points.length <= 8 || i % Math.ceil(points.length / 8) === 0 || i === points.length - 1;
        return (
          <g key={p.date.toISOString()}>
            <title>{`${fmt.format(p.date)}: ${p.avg == null ? "no active onboardings" : `${p.avg}% average across ${p.onboardings} onboarding${p.onboardings === 1 ? "" : "s"}`}`}</title>
            {p.avg == null ? (
              <rect x={x} y={pad.t + innerH - 2} width={barW} height={2} fill="#d9d5e0" />
            ) : (
              <>
                <rect x={x} y={pad.t + innerH - bh} width={barW} height={bh} rx={3} fill="#7c3aed" opacity={0.85} />
                {barW >= 22 && (
                  <text x={x + barW / 2} y={pad.t + innerH - bh - 4} textAnchor="middle" fontSize="10" fill="#4b4558">{p.avg}</text>
                )}
              </>
            )}
            {showLabel && (
              <text x={x + barW / 2} y={h - 10} textAnchor="middle" fontSize="10" fill="#8a8597">{fmt.format(p.date)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function HBar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
      <div className="h-full rounded-full bg-brand-500" style={{ width: `${max ? Math.max(4, (value / max) * 100) : 0}%` }} />
    </div>
  );
}
