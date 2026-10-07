import type { Tx } from "@/lib/db";
import type { Vocabulary } from "./describe";

type Content = { sections?: { key: string; title: string; items?: { key: string; title: string }[] }[] };

/** Templates (published content, falling back to the draft), client types and staff for rule sentences and the builder. */
export async function loadVocabulary(tx: Tx): Promise<Vocabulary> {
  // Sequential on purpose: one pg client can't run queries concurrently.
  const templates = await tx.q<{ id: string; name: string; content: Content | null }>(
    `select t.id, t.name, coalesce(v.content, t.draft) as content
     from templates t left join template_versions v on v.template_id = t.id and v.version = t.current_version
     where not t.archived order by t.name`,
  );
  const clientTypes = await tx.q<{ id: string; name: string }>("select id, name from client_types order by position, name");
  const staff = await tx.q<{ id: string; name: string; role: string }>(
    "select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id where m.role in ('admin', 'manager', 'staff') order by u.name",
  );
  return {
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      sections: (t.content?.sections ?? []).map((s) => ({ key: s.key, title: s.title, items: (s.items ?? []).map((i) => ({ key: i.key, title: i.title })) })),
    })),
    clientTypes,
    staff,
  };
}

export interface RuleListRow {
  id: string;
  name: string;
  description: string | null;
  category: "automation" | "escalation" | "handoff";
  enabled: boolean;
  trigger: string;
  trigger_config: { days?: number; hours?: number; itemKey?: string } | null;
  conditions: import("@/lib/automation/catalog").Condition[];
  condition_mode: "all" | "any";
  actions: import("@/lib/automation/catalog").AutomationAction[];
  run_mode: "once_per_onboarding" | "every_event";
  template_id: string | null;
  updated_at: Date;
  last_run_at: Date | null;
  last_status: string | null;
  runs_total: number;
  runs_succeeded: number;
  runs_failed: number;
}

export function loadRules(tx: Tx, where = "true", params: unknown[] = []) {
  return tx.q<RuleListRow>(
    `select r.*, s.last_run_at, s.last_status, coalesce(s.runs_total, 0)::int as runs_total,
            coalesce(s.runs_succeeded, 0)::int as runs_succeeded, coalesce(s.runs_failed, 0)::int as runs_failed
     from automation_rules r
     left join lateral (
       select max(created_at) as last_run_at,
              (array_agg(status order by created_at desc))[1] as last_status,
              count(*) as runs_total,
              count(*) filter (where status = 'succeeded') as runs_succeeded,
              count(*) filter (where status in ('failed', 'partial')) as runs_failed
       from automation_runs where rule_id = r.id
     ) s on true
     where ${where}
     order by r.category, r.created_at`,
    params,
  );
}
