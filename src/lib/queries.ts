import type { Tx } from "./db";
import { computeOnboardingState, type ItemLike, type ItemStatus } from "./onboarding";

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
     where m.role in ('admin', 'staff') order by u.name`,
  );
  return { list: rows, map: new Map(rows.map((r) => [r.id, r.name])) };
}

export async function loadOnboardings(tx: Tx, where = "true", params: unknown[] = []) {
  const onboardings = await tx.q<OnboardingRow>(
    `select o.id, o.name, o.status, o.owner_user_id, u.name as owner_name, o.client_id, c.name as client_name,
            c.timezone as client_timezone, o.template_name, o.template_version, o.start_date::text, o.created_at, o.completed_at,
            o.reminders_enabled
     from onboardings o join clients c on c.id = o.client_id left join users u on u.id = o.owner_user_id
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
    return { ...o, items: its, state: computeOnboardingState(o, its) };
  });
}

export type LoadedOnboarding = Awaited<ReturnType<typeof loadOnboardings>>[number];
