import Link from "next/link";
import type { Tx } from "@/lib/db";
import { ACTION_LABEL, TRIGGER_INFO, type TriggerType } from "@/lib/automation/catalog";
import { formatDateTime } from "@/lib/time";
import { Badge, EmptyState } from "@/components/ui";
import { RunStatusBadge } from "./ui";

export interface RunRow {
  id: string;
  rule_id: string;
  rule_name: string;
  client_id: string | null;
  client_name: string | null;
  trigger: string;
  status: string;
  results: { type: string; status: "done" | "skipped" | "failed"; detail: string }[];
  error: string | null;
  created_at: Date;
}

export const RUN_STATUSES = ["succeeded", "partial", "failed", "skipped"] as const;

export function loadRuns(tx: Tx, f: { ruleId?: string | null; status?: string | null; limit?: number }) {
  return tx.q<RunRow>(
    `select r.id, r.rule_id, ar.name as rule_name, r.client_id, c.name as client_name, r.trigger, r.status, r.results, r.error, r.created_at
     from automation_runs r join automation_rules ar on ar.id = r.rule_id left join clients c on c.id = r.client_id
     where ($1::uuid is null or r.rule_id = $1) and ($2::text is null or r.status = $2)
     order by r.created_at desc limit $3`,
    [f.ruleId ?? null, f.status ?? null, f.limit ?? 100],
  );
}

const triggerLabel = (t: string) => TRIGGER_INFO[t as TriggerType]?.label ?? t.replace(/_/g, " ");
const RESULT_TONE = { done: "success", skipped: "neutral", failed: "danger" } as const;
const RESULT_LABEL = { done: "Done", skipped: "Skipped", failed: "Failed" } as const;

export function RunTable({ runs, showRule = true }: { runs: RunRow[]; showRule?: boolean }) {
  if (runs.length === 0) return <EmptyState title="No runs yet" description="Runs appear here as soon as a rule's trigger fires and its conditions match." />;
  return (
    <ul className="card divide-y divide-ink-100">
      {runs.map((r) => (
        <li key={r.id} className="p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-900">
                {showRule ? (
                  <Link href={`/app/automations/${r.rule_id}`} className="hover:text-brand-700">
                    {r.rule_name}
                  </Link>
                ) : (
                  triggerLabel(r.trigger)
                )}
                {r.client_id && (
                  <>
                    <span className="mx-1.5 text-ink-300">·</span>
                    <Link href={`/app/clients/${r.client_id}`} className="link">
                      {r.client_name ?? "Client"}
                    </Link>
                  </>
                )}
              </p>
              {showRule && <p className="text-xs text-ink-500">Trigger: {triggerLabel(r.trigger)}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-ink-500">
              <RunStatusBadge status={r.status} />
              <time dateTime={new Date(r.created_at).toISOString()}>{formatDateTime(r.created_at)}</time>
            </div>
          </div>
          {r.results.length > 0 && (
            <ul className="mt-2 space-y-1">
              {r.results.map((a, i) => (
                <li key={i} className="flex min-w-0 items-start gap-2 text-sm">
                  <Badge tone={RESULT_TONE[a.status] ?? "neutral"} className="mt-0.5">
                    {RESULT_LABEL[a.status] ?? a.status}
                  </Badge>
                  <span className="min-w-0 break-words text-ink-700">
                    <span className="text-ink-500">{ACTION_LABEL[a.type as keyof typeof ACTION_LABEL] ?? a.type}:</span> {a.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {r.error && <p className="mt-2 text-sm text-rose-700">{r.error}</p>}
        </li>
      ))}
    </ul>
  );
}
