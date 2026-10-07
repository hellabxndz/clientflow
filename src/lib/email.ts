import { env } from "./env";
import type { Tx } from "./db";

export type EmailMode = "live" | "demo" | "not_configured";

export function emailConnection(workspace: { is_demo: boolean }): { mode: EmailMode; provider: string; detail: string } {
  if (workspace.is_demo)
    return { mode: "demo", provider: "demo-outbox", detail: "Demo workspace: emails are recorded in the outbox and never sent." };
  if (process.env.DISABLE_EMAIL_SENDING === "true")
    return { mode: "demo", provider: "demo-outbox", detail: "DISABLE_EMAIL_SENDING is set: emails are recorded but not sent." };
  if (env.resendApiKey && env.emailFrom)
    return { mode: "live", provider: "resend", detail: `Sending through Resend as ${env.emailFrom}.` };
  return {
    mode: "not_configured",
    provider: "none",
    detail: "No email provider configured. Set RESEND_API_KEY and EMAIL_FROM to send email.",
  };
}

export interface OutgoingEmail {
  workspaceId: string;
  kind: "reminder" | "invitation" | "notification" | "escalation" | "automation";
  to: string;
  subject: string;
  body: string;
  ruleId?: string | null;
  onboardingId?: string | null;
  itemIds?: string[];
  dedupeKey?: string | null;
  createdAt?: Date;
  automationRunId?: string | null;
}

async function deliverViaResend(fromName: string | null, to: string, subject: string, body: string) {
  const from = fromName ? `${fromName.replace(/[<>"]/g, "")} <${env.emailFrom}>` : env.emailFrom;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text: body }),
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(json.message ?? `Resend returned ${res.status}`);
  return json.id ?? null;
}

/**
 * Records the email first (the unique dedupe key prevents duplicate sends), then delivers it
 * according to the workspace's connection mode and stores the outcome.
 * Returns null when a message with the same dedupe key already exists.
 */
export async function sendEmail(
  tx: Tx,
  workspace: { is_demo: boolean; email_from_name?: string | null },
  msg: OutgoingEmail,
): Promise<{ id: string; status: "sent" | "simulated" | "failed"; error?: string } | null> {
  const row = await tx.one<{ id: string }>(
    `insert into email_messages (workspace_id, kind, rule_id, onboarding_id, item_ids, dedupe_key, to_email, subject, body, status, created_at, automation_run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued', coalesce($10::timestamptz, now()), $11)
     on conflict (dedupe_key) do nothing returning id`,
    [
      msg.workspaceId,
      msg.kind,
      msg.ruleId ?? null,
      msg.onboardingId ?? null,
      msg.itemIds ?? [],
      msg.dedupeKey ?? null,
      msg.to,
      msg.subject,
      msg.body,
      msg.createdAt ?? null,
      msg.automationRunId ?? null,
    ],
  );
  if (!row) return null;
  return deliverRecorded(tx, workspace, { id: row.id, to: msg.to, subject: msg.subject, body: msg.body });
}

/** Delivers an already-recorded message according to the workspace's connection mode and stores the outcome. */
export async function deliverRecorded(
  tx: Tx,
  workspace: { is_demo: boolean; email_from_name?: string | null },
  row: { id: string; to: string; subject: string; body: string },
): Promise<{ id: string; status: "sent" | "simulated" | "failed"; error?: string }> {
  const conn = emailConnection(workspace);
  if (conn.mode === "demo") {
    await tx.q("update email_messages set status = 'simulated', provider = $2, sent_at = now() where id = $1", [row.id, conn.provider]);
    return { id: row.id, status: "simulated" };
  }
  if (conn.mode === "not_configured") {
    const error = "Not sent: no email provider configured";
    await tx.q("update email_messages set status = 'failed', provider = 'none', error = $2 where id = $1", [row.id, error]);
    return { id: row.id, status: "failed", error };
  }
  try {
    const providerId = await deliverViaResend(workspace.email_from_name ?? null, row.to, row.subject, row.body);
    await tx.q(
      "update email_messages set status = 'sent', provider = 'resend', provider_message_id = $2, sent_at = now() where id = $1",
      [row.id, providerId],
    );
    return { id: row.id, status: "sent" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await tx.q("update email_messages set status = 'failed', provider = 'resend', error = $2 where id = $1", [row.id, error.slice(0, 500)]);
    return { id: row.id, status: "failed", error };
  }
}
