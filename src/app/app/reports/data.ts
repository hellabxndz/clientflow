import type { Tx } from "@/lib/db";
import { MIN_SAMPLE, type Period } from "@/lib/reports";

export const PRESETS = [30, 90, 180] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RangeSelection {
  period: Period;
  preset: (typeof PRESETS)[number] | null;
  days: number;
  from: string;
  to: string;
  error?: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Reads ?range=30|90|180 or ?from=YYYY-MM-DD&to=YYYY-MM-DD. "to" is inclusive. */
export function parseRange(sp: { range?: string; from?: string; to?: string }, now = new Date()): RangeSelection {
  if (sp.from && sp.to && DATE.test(sp.from) && DATE.test(sp.to)) {
    const from = new Date(`${sp.from}T00:00:00Z`);
    const to = new Date(new Date(`${sp.to}T00:00:00Z`).getTime() + 86400000);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to) {
      const days = Math.round((to.getTime() - from.getTime()) / 86400000);
      if (days <= 3660) return { period: { from, to }, preset: null, days, from: sp.from, to: sp.to };
    }
    return { ...parseRange({}, now), error: "That date range isn't valid, so the last 90 days are shown." };
  }
  const preset = PRESETS.find((p) => String(p) === sp.range) ?? 90;
  const to = now;
  const from = new Date(to.getTime() - preset * 86400000);
  return { period: { from, to }, preset, days: preset, from: iso(from), to: iso(to) };
}

/** Average time from a submission to the staff review decision, for reviews made in the period. */
export async function reviewTime(tx: Tx, p: Period) {
  const [r] = await tx.q<{ avg: number | null; n: number }>(
    `select round(avg(extract(epoch from reviewed_at - submitted_at) / 3600)::numeric, 1)::float as avg, count(*)::int as n
     from onboarding_items where reviewed_at >= $1 and reviewed_at < $2 and submitted_at is not null and reviewed_at >= submitted_at and removed_at is null`,
    [p.from, p.to],
  );
  return { hours: r.n >= MIN_SAMPLE ? r.avg : null, sample: r.n };
}
