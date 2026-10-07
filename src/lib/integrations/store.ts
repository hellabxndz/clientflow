import { sysQuery, type Tx } from "../db";
import { env } from "../env";
import { decryptSecrets, encryptSecrets } from "./crypto";
import { providerById, type ConnectionState, type ProviderInfo } from "./catalog";

export interface IntegrationRow {
  id: string;
  provider: string;
  status: "configured" | "connected" | "error" | "disconnected";
  config: Record<string, string>;
  connected_at: Date | null;
  last_tested_at: Date | null;
  last_event_at: Date | null;
  last_error: string | null;
}

export async function listIntegrations(tx: Tx) {
  return tx.q<IntegrationRow>(
    "select id, provider, status, config, connected_at, last_tested_at, last_event_at, last_error from integrations order by provider",
  );
}

/** Honest connection state: "Connected" only after a successful test call or a verified inbound webhook. */
export function connectionState(provider: ProviderInfo, row: IntegrationRow | undefined, opts: { isDemo?: boolean } = {}): { state: ConnectionState; detail: string } {
  if (provider.availability === "coming_soon") return { state: "coming_soon", detail: provider.note ?? "Not built yet." };
  if (provider.availability === "env") {
    if (provider.id === "resend") {
      if (opts.isDemo) return { state: "not_connected", detail: "Demo workspace: email is recorded in the outbox and never sent." };
      return env.resendApiKey && env.emailFrom
        ? { state: "connected", detail: `Configured on the server. Sending as ${env.emailFrom}. Delivery results appear in the email log.` }
        : { state: "configuration_required", detail: "Set RESEND_API_KEY and EMAIL_FROM on the server, with a verified sending domain." };
    }
    if (provider.id === "clamav")
      return env.clamavHost
        ? { state: "connected", detail: `Uploads are scanned by clamd at ${env.clamavHost}:${env.clamavPort}.` }
        : { state: "configuration_required", detail: "File scanning integration not configured. Enable before handling sensitive production documents." };
  }
  if (!row || row.status === "disconnected") return { state: "not_connected", detail: "Not connected." };
  if (row.status === "connected")
    return {
      state: "connected",
      detail: row.last_event_at
        ? `Last activity ${new Date(row.last_event_at).toLocaleString("en-US")}.`
        : `Verified ${row.last_tested_at ? new Date(row.last_tested_at).toLocaleString("en-US") : ""}.`,
    };
  if (row.status === "error") return { state: "configuration_required", detail: row.last_error ?? "The last check failed." };
  return {
    state: "configuration_required",
    detail: provider.webhook && !provider.testable
      ? "Credentials saved. It shows as Connected after the first signed webhook is received."
      : "Credentials saved. Run a connection test to finish.",
  };
}

/** Saves configuration and credentials (encrypted). Blank secret fields keep the stored value. */
export async function saveIntegration(
  workspaceId: string,
  providerId: string,
  values: Record<string, string>,
  userId: string,
) {
  const provider = providerById(providerId);
  if (!provider || provider.availability !== "adapter") throw new Error("This integration can't be configured here.");
  const [existing] = await sysQuery<{ secrets_enc: string | null; config: Record<string, string> }>(
    "select secrets_enc, config from integrations where workspace_id = $1 and provider = $2",
    [workspaceId, providerId],
  );
  const secrets = decryptSecrets(existing?.secrets_enc ?? null);
  const config: Record<string, string> = { ...(existing?.config ?? {}) };
  for (const f of provider.fields ?? []) {
    const v = (values[f.key] ?? "").trim();
    if (f.secret) {
      if (v) secrets[f.key] = v;
    } else config[f.key] = v;
    const has = f.secret ? !!secrets[f.key] : !!config[f.key];
    if (f.required && !has) throw new Error(`${f.label} is required.`);
  }
  if (providerId === "slack" && !/^https:\/\/hooks\.slack\.com\//.test(secrets.webhookUrl ?? "")) throw new Error("Use a Slack incoming webhook URL (https://hooks.slack.com/…).");
  if (providerId === "teams" && !/^https:\/\//.test(secrets.webhookUrl ?? "")) throw new Error("Use the HTTPS webhook URL from Teams Workflows.");
  await sysQuery(
    `insert into integrations (workspace_id, provider, status, config, secrets_enc, connected_by, updated_at)
     values ($1, $2, 'configured', $3, $4, $5, now())
     on conflict (workspace_id, provider) do update set status = 'configured', config = excluded.config, secrets_enc = excluded.secrets_enc,
       connected_by = excluded.connected_by, last_error = null, updated_at = now()`,
    [workspaceId, providerId, JSON.stringify(config), encryptSecrets(secrets), userId],
  );
}

export async function loadIntegration(workspaceId: string, providerId: string) {
  const [row] = await sysQuery<IntegrationRow & { secrets_enc: string | null }>(
    "select * from integrations where workspace_id = $1 and provider = $2",
    [workspaceId, providerId],
  );
  if (!row || row.status === "disconnected") return null;
  return { row, config: row.config ?? {}, secrets: decryptSecrets(row.secrets_enc) };
}

export async function setIntegrationStatus(
  workspaceId: string,
  providerId: string,
  status: IntegrationRow["status"],
  opts: { error?: string | null; tested?: boolean; event?: boolean } = {},
) {
  await sysQuery(
    `update integrations set status = $3, last_error = $4,
       connected_at = case when $3 = 'connected' and connected_at is null then now() else connected_at end,
       last_tested_at = case when $5 then now() else last_tested_at end,
       last_event_at = case when $6 then now() else last_event_at end,
       updated_at = now()
     where workspace_id = $1 and provider = $2`,
    [workspaceId, providerId, status, opts.error ?? null, !!opts.tested, !!opts.event],
  );
}

export async function disconnectIntegration(workspaceId: string, providerId: string) {
  await sysQuery(
    "update integrations set status = 'disconnected', secrets_enc = null, connected_at = null, last_error = null, updated_at = now() where workspace_id = $1 and provider = $2",
    [workspaceId, providerId],
  );
}

export async function recordIntegrationEvent(
  tx: Tx,
  e: {
    workspaceId: string;
    provider: string;
    direction: "inbound" | "outbound";
    eventType: string;
    status: "processed" | "ignored" | "failed" | "duplicate" | "simulated" | "skipped";
    detail?: string | null;
    externalId?: string | null;
    clientId?: string | null;
    onboardingId?: string | null;
  },
) {
  await tx.q(
    `insert into integration_events (workspace_id, provider, direction, external_id, event_type, status, detail, client_id, onboarding_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.workspaceId, e.provider, e.direction, e.externalId ?? null, e.eventType, e.status, e.detail?.slice(0, 500) ?? null, e.clientId ?? null, e.onboardingId ?? null],
  );
}

/** Small fetch wrapper with a timeout and readable errors for adapter calls. */
export async function callApi(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json as { message?: string; err?: string; error?: string } | null)?.message ?? (json as { err?: string } | null)?.err ?? text.slice(0, 200);
    throw new Error(`${new URL(url).host} returned ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  return { json, text, status: res.status };
}
