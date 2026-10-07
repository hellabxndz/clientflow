import type { Tx } from "./db";

export type TimelineKind = "client" | "staff" | "automation" | "email" | "system" | "review";

export interface TimelineEntry {
  id: string;
  at: Date;
  kind: TimelineKind;
  title: string;
  detail?: string | null;
  actor?: string | null;
}

function kindOf(action: string, actorRole: string | null): TimelineKind {
  if (action.startsWith("automation.")) return "automation";
  if (action.startsWith("item.approved") || action.startsWith("item.changes") || action.startsWith("document.reviewed")) return "review";
  if (actorRole === "client") return "client";
  if (actorRole) return "staff";
  return "system";
}

/**
 * A client's complete history, built from the audit log (every write path records there),
 * emails and reminders, and automation runs that were skipped or failed. Staff only.
 */
export async function clientTimeline(tx: Tx, clientId: string, limit = 200): Promise<TimelineEntry[]> {
  const audits = await tx.q<{ id: string; created_at: Date; action: string; summary: string; actor: string | null; role: string | null }>(
    `select a.id::text, a.created_at, a.action, a.summary, u.name as actor, m.role
     from audit_events a left join users u on u.id = a.actor_user_id
     left join memberships m on m.user_id = a.actor_user_id and m.workspace_id = a.workspace_id
     where a.client_id = $1 order by a.created_at desc limit $2`,
    [clientId, limit],
  );
  const emails = await tx.q<{ id: string; created_at: Date; kind: string; status: string; to_email: string; subject: string; error: string | null; status_reason: string | null; send_after: Date | null }>(
    `select e.id, coalesce(e.sent_at, e.created_at) as created_at, e.kind, e.status, e.to_email, e.subject, e.error, e.status_reason, e.send_after
     from email_messages e join onboardings o on o.id = e.onboarding_id
     where o.client_id = $1 and e.kind in ('reminder', 'automation') order by e.created_at desc limit $2`,
    [clientId, limit],
  );
  const runs = await tx.q<{ id: string; created_at: Date; status: string; name: string; results: { detail: string; status: string }[] }>(
    `select r.id, r.created_at, r.status, ar.name, r.results from automation_runs r join automation_rules ar on ar.id = r.rule_id
     where r.client_id = $1 and r.status in ('skipped', 'failed', 'partial') order by r.created_at desc limit 50`,
    [clientId],
  );
  const entries: TimelineEntry[] = [
    ...audits.map((a) => ({ id: `a${a.id}`, at: a.created_at, kind: kindOf(a.action, a.role), title: a.summary, actor: a.actor })),
    ...emails.map((e) => ({
      id: `e${e.id}`,
      at: e.status === "scheduled" && e.send_after ? e.send_after : e.created_at,
      kind: "email" as const,
      title:
        e.status === "scheduled"
          ? `Reminder scheduled to ${e.to_email}`
          : e.status === "cancelled" || e.status === "skipped"
            ? `Reminder to ${e.to_email} ${e.status}`
            : `${e.kind === "reminder" ? "Reminder" : "Email"} ${e.status === "simulated" ? "recorded (demo, not sent)" : e.status} to ${e.to_email}`,
      detail: e.status_reason ?? e.error ?? e.subject,
    })),
    ...runs.map((r) => ({
      id: `r${r.id}`,
      at: r.created_at,
      kind: "automation" as const,
      title: `Automation "${r.name}" ${r.status}`,
      detail: r.results.filter((x) => x.status !== "done").map((x) => x.detail).join("; "),
    })),
  ];
  return entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
}
