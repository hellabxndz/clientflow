import type { Tx } from "./db";
import { computeOnboardingState, projectKickoff, type ItemLike, type ItemStatus } from "./onboarding";

export interface OnboardingRow {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "cancelled";
  owner_user_id: string | null;
  owner_name: string | null;
  client_id: string;
  client_name: string;
  client_timezone: string;
  template_name: string | null;
  template_version: number | null;
  start_date: string;
  created_at: Date;
  completed_at: Date | null;
  reminders_enabled: boolean;
  kickoff_ready_at: Date | null;
  kickoff_date: string | null;
  handed_off_at: Date | null;
  at_risk: boolean;
  at_risk_reason: string | null;
  paused_at: Date | null;
  last_client_activity_at: Date | null;
  source: string;
  template_id: string | null;
  client_type_id: string | null;
  client_type_name: string | null;
  deal_amount: string | null;
  deal_recurrence: "one_time" | "monthly" | "annual";
  client_owner_id: string | null;
}

export interface ItemRow extends ItemLike {
  onboarding_id: string;
  client_id: string;
  section_key: string;
  position: number;
  description: string | null;
  config: Record<string, unknown>;
  response: Record<string, unknown>;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  submitted_at: Date | null;
  updated_at: Date;
  status: ItemStatus;
}

export async function staffNames(tx: Tx) {
  const rows = await tx.q<{ id: string; name: string; role: string; can_approve: boolean; email: string }>(
    `select u.id, u.name, u.email, m.role, m.can_approve from memberships m join users u on u.id = m.user_id
     where m.role in ('admin', 'manager', 'staff') order by u.name`,
  );
  return { list: rows, map: new Map(rows.map((r) => [r.id, r.name])) };
}

/**
 * Loads onboardings with their live items and computed state (readiness, blockers, stage, projected kickoff).
 * `where` is SQL over aliases o (onboardings) and c (clients); RLS still applies.
 */
export async function loadOnboardings(
  tx: Tx,
  where = "true",
  params: unknown[] = [],
  opts: { leadDays?: number; businessDays?: number[] } = {},
) {
  const onboardings = await tx.q<OnboardingRow>(
    `select o.id, o.name, o.status, o.owner_user_id, u.name as owner_name, o.client_id, c.name as client_name,
            c.timezone as client_timezone, o.template_name, o.template_version, o.start_date::text, o.created_at, o.completed_at,
            o.reminders_enabled, o.kickoff_ready_at, o.kickoff_date::text, o.handed_off_at, o.at_risk, o.at_risk_reason, o.paused_at,
            o.last_client_activity_at, o.source, o.template_id, c.client_type_id, ct.name as client_type_name, c.deal_amount::text,
            c.deal_recurrence, c.owner_user_id as client_owner_id
     from onboardings o join clients c on c.id = o.client_id left join users u on u.id = o.owner_user_id
     left join client_types ct on ct.id = c.client_type_id
     where ${where} order by o.created_at desc`,
    params,
  );
  if (onboardings.length === 0) return [];
  const items = await tx.q<ItemRow>(
    `select * from onboarding_items where onboarding_id = any($1) order by position`,
    [onboardings.map((o) => o.id)],
  );
  const byOnb = new Map<string, ItemRow[]>();
  for (const i of items) {
    const list = byOnb.get(i.onboarding_id) ?? [];
    list.push(i);
    byOnb.set(i.onboarding_id, list);
  }
  return onboardings.map((o) => {
    const its = byOnb.get(o.id) ?? [];
    return { ...o, items: its, state: computeOnboardingState(o, its), kickoff: projectKickoff(o, its, opts) };
  });
}

export type LoadedOnboarding = Awaited<ReturnType<typeof loadOnboardings>>[number];

/** Monthly-equivalent contract value, used for "Contract Value in Active Onboarding". */
export function contractValue(o: { deal_amount: string | null; deal_recurrence: string }) {
  const amount = o.deal_amount ? Number(o.deal_amount) : 0;
  return { amount, recurrence: o.deal_recurrence as "one_time" | "monthly" | "annual" };
}

export function formatMoney(amount: number, recurrence?: "one_time" | "monthly" | "annual") {
  const s = amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return recurrence === "monthly" ? `${s}/mo` : recurrence === "annual" ? `${s}/yr` : s;
}

/** Sums deal values by recurrence, so monthly retainers and one-time projects are never added together. */
export function sumContracts(rows: { deal_amount: string | null; deal_recurrence: string }[]) {
  const totals = { monthly: 0, annual: 0, one_time: 0, count: 0 };
  for (const r of rows) {
    if (!r.deal_amount) continue;
    totals[r.deal_recurrence as "monthly" | "annual" | "one_time"] += Number(r.deal_amount);
    totals.count++;
  }
  return totals;
}
