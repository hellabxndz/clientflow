import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { sysQuery, withTenant } from "@/lib/db";
import { env } from "@/lib/env";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { CATEGORY_LABEL, PROVIDERS, STATE_LABEL, type ConnectionState, type IntegrationCategory, type ProviderInfo } from "@/lib/integrations/catalog";
import { connectionState, listIntegrations, type IntegrationRow } from "@/lib/integrations/store";
import { decryptSecrets, usingFallbackKey } from "@/lib/integrations/crypto";
import { disconnectIntegrationAction, saveIntegrationAction, testIntegrationAction } from "./actions";
import { SecretGenerator, SimulateDealForm } from "./client-forms";

export const metadata = { title: "Integrations" };

const STATE_TONE: Record<ConnectionState, "success" | "neutral" | "warning" | "info"> = {
  connected: "success",
  not_connected: "neutral",
  configuration_required: "warning",
  coming_soon: "info",
};

const EVENT_TONE = { processed: "success", simulated: "brand", duplicate: "neutral", ignored: "neutral", skipped: "neutral", failed: "danger" } as const;

interface EventRow {
  id: string;
  provider: string;
  direction: "inbound" | "outbound";
  event_type: string;
  status: keyof typeof EVENT_TONE;
  detail: string | null;
  client_id: string | null;
  client_name: string | null;
  created_at: Date;
}

/** Which secret fields hold a value, per provider. Values never leave the server; only the key names do. */
async function savedSecretKeys(workspaceId: string) {
  const rows = await sysQuery<{ provider: string; secrets_enc: string | null }>(
    "select provider, secrets_enc from integrations where workspace_id = $1 and status <> 'disconnected'",
    [workspaceId],
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    try {
      const secrets = decryptSecrets(r.secrets_enc);
      out.set(r.provider, new Set(Object.keys(secrets).filter((k) => !!secrets[k])));
    } catch {
      out.set(r.provider, new Set());
    }
  }
  return out;
}

export default async function IntegrationsPage() {
  const auth = await requireStaff();
  const admin = auth.role === "admin";
  const manager = admin || auth.role === "manager";
  const demo = auth.workspace.is_demo;
  const { rows, events, clientTypes } = await withTenant(tenantCtx(auth), async (tx) => ({
    rows: await listIntegrations(tx),
    events: await tx.q<EventRow>(
      `select e.id, e.provider, e.direction, e.event_type, e.status, e.detail, e.client_id, c.name as client_name, e.created_at
       from integration_events e left join clients c on c.id = e.client_id
       order by e.created_at desc limit 200`,
    ),
    clientTypes: (await tx.q<{ name: string }>("select name from client_types order by position, name")).map((r) => r.name),
  }));
  const secretKeys = admin ? await savedSecretKeys(auth.workspace.id) : new Map<string, Set<string>>();
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const categories = Object.keys(CATEGORY_LABEL) as IntegrationCategory[];
  const states = PROVIDERS.map((p) => connectionState(p, byProvider.get(p.id), { isDemo: demo }).state);
  const connectedCount = states.filter((s) => s === "connected").length;

  return (
    <div>
      <PageHeader
        title="Integrations"
        description={`${connectedCount} of ${PROVIDERS.length} connected. A tool shows as Connected only after a real test call or a verified webhook.`}
      />
      <div className="mb-6 space-y-3">
        {demo && (
          <Notice tone="info" title="Demo workspace">
            Nothing here contacts a real service: email goes to the outbox, Slack, Teams and project tools are skipped, and live CRM webhooks are refused.
            Use the deal simulation below to see the closed-won flow end to end.
          </Notice>
        )}
        {!admin && <Notice>Only workspace admins can connect or disconnect integrations. You can see their status and recent activity.</Notice>}
        {admin && usingFallbackKey() && (
          <Notice tone="warning" title="Encryption key not set">
            Credentials are encrypted with a key derived from SESSION_SECRET. Set INTEGRATION_ENCRYPTION_KEY (32+ characters) before storing production
            credentials; changing it later requires re-entering them.
          </Notice>
        )}
      </div>

      {demo && manager && (
        <Card title="Simulate a closed-won deal" className="mb-8">
          <Notice tone="warning" className="mb-4">
            Demo simulation — no CRM is contacted. This runs the same import pipeline a verified webhook would: it creates the client, records the deal,
            and your automations start the onboarding.
          </Notice>
          <SimulateDealForm clientTypes={clientTypes} />
        </Card>
      )}

      <div className="space-y-10">
        {categories.map((cat) => {
          const providers = PROVIDERS.filter((p) => p.category === cat);
          if (providers.length === 0) return null;
          return (
            <section key={cat}>
              <h2 className="mb-3 text-[15px] font-semibold text-ink-900">{CATEGORY_LABEL[cat]}</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {providers.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    row={byProvider.get(p.id)}
                    demo={demo}
                    admin={admin}
                    slug={auth.workspace.slug}
                    savedSecrets={secretKeys.get(p.id) ?? new Set()}
                    events={events.filter((e) => e.provider === p.id).slice(0, 5)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProviderCard({
  provider: p,
  row,
  demo,
  admin,
  slug,
  savedSecrets,
  events,
}: {
  provider: ProviderInfo;
  row: IntegrationRow | undefined;
  demo: boolean;
  admin: boolean;
  slug: string;
  savedSecrets: Set<string>;
  events: EventRow[];
}) {
  const { state, detail } = connectionState(p, row, { isDemo: demo });
  const active = !!row && row.status !== "disconnected";
  const webhookUrl = `${env.appUrl}/api/integrations/${p.id}/webhook?workspace=${encodeURIComponent(slug)}`;
  const usesSigningSecret = (p.fields ?? []).some((f) => f.key === "signingSecret");
  return (
    <section className="card flex min-w-0 flex-col p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink-900">{p.name}</h3>
          <p className="mt-0.5 text-sm text-ink-600">{p.description}</p>
        </div>
        <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </div>
      {state !== "coming_soon" && <p className={`mt-3 text-sm ${state === "configuration_required" ? "text-amber-800" : "text-ink-600"}`}>{detail}</p>}
      {p.note && <p className="mt-2 text-xs text-ink-500">{p.note}</p>}

      {p.webhook && (
        <div className="mt-4 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Webhook URL</p>
          <code className="mt-1 block break-all rounded-md bg-ink-50 px-2 py-1.5 text-xs text-ink-800 ring-1 ring-inset ring-ink-200">{webhookUrl}</code>
          {demo && <p className="mt-1 text-xs text-ink-500">Demo workspaces refuse live webhooks.</p>}
          {p.id === "webhook" && (
            <p className="mt-1 text-xs text-ink-500">
              POST JSON <code>{`{"event":"deal.closed_won","deal":{…},"company":{…},"contact":{…}}`}</code> with header <code>X-ClientFlow-Signature</code> = hex
              HMAC-SHA256 of the raw body.
            </p>
          )}
        </div>
      )}
      {p.setup && p.setup.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">Setup steps</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-600">
            {p.setup.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      {admin && p.availability === "adapter" && (
        <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          {demo ? (
            <p className="text-sm text-ink-500">Configuration is disabled in demo workspaces.</p>
          ) : (
            <>
              <details open={!active}>
                <summary className="cursor-pointer text-sm font-medium text-ink-700">{active ? "Update settings" : "Configure"}</summary>
                <ActionForm action={saveIntegrationAction} className="mt-3 space-y-3">
                  <input type="hidden" name="provider" value={p.id} />
                  {(p.fields ?? []).map((f) => {
                    const saved = f.secret && savedSecrets.has(f.key);
                    return (
                      <label key={f.key} className="block min-w-0">
                        <span className="label flex items-center gap-2">
                          {f.label}
                          {f.required && !saved && <span className="text-rose-600">*</span>}
                          {saved && <Badge tone="success">Saved</Badge>}
                        </span>
                        <input
                          name={f.key}
                          className="input"
                          type={f.secret ? "password" : "text"}
                          autoComplete="off"
                          defaultValue={f.secret ? "" : row?.config?.[f.key] ?? ""}
                          placeholder={saved ? "Saved — leave blank to keep" : f.placeholder}
                        />
                        {f.help && <span className="mt-1 block text-xs text-ink-500">{f.help}</span>}
                      </label>
                    );
                  })}
                  <SubmitButton pendingText="Saving…">Save</SubmitButton>
                  <p className="text-xs text-ink-500">Secrets are encrypted at rest and never shown again after saving.</p>
                </ActionForm>
              </details>
              {usesSigningSecret && (
                <div>
                  <SecretGenerator provider={p.id} hasSecret={savedSecrets.has("signingSecret")} />
                  <p className="mt-1 text-xs text-ink-500">
                    HMAC verification needs the original secret, so it is stored encrypted with your other credentials rather than as a hash.
                  </p>
                </div>
              )}
              {active && (
                <div className="flex flex-wrap items-start gap-2">
                  {p.testable && (
                    <ActionForm action={testIntegrationAction}>
                      <input type="hidden" name="provider" value={p.id} />
                      <SubmitButton className="btn-secondary" pendingText="Testing…">
                        Test connection
                      </SubmitButton>
                    </ActionForm>
                  )}
                  <ActionForm action={disconnectIntegrationAction} confirm={`Disconnect ${p.name}? Stored credentials will be deleted.`}>
                    <input type="hidden" name="provider" value={p.id} />
                    <SubmitButton className="btn-ghost text-rose-700" pendingText="Disconnecting…">
                      Disconnect
                    </SubmitButton>
                  </ActionForm>
                </div>
              )}
              {row?.last_tested_at && <p className="text-xs text-ink-500">Last tested {formatDateTime(row.last_tested_at)}</p>}
            </>
          )}
        </div>
      )}
      {admin && demo && p.testable && (
        <ActionForm action={testIntegrationAction} className="mt-3">
          <input type="hidden" name="provider" value={p.id} />
          <SubmitButton className="btn-secondary" pendingText="Testing…">
            Test connection
          </SubmitButton>
        </ActionForm>
      )}

      {events.length > 0 && (
        <div className="mt-4 border-t border-ink-100 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Recent activity</p>
          <ul className="mt-2 space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex min-w-0 items-start gap-2 text-xs">
                <Badge tone={EVENT_TONE[e.status] ?? "neutral"}>{e.status}</Badge>
                <span className="min-w-0 flex-1 break-words text-ink-600">
                  {e.detail ?? e.event_type}
                  {e.client_id && (
                    <>
                      {" · "}
                      <Link href={`/app/clients/${e.client_id}`} className="link">
                        {e.client_name ?? "Client"}
                      </Link>
                    </>
                  )}
                </span>
                <time className="shrink-0 text-ink-400">{formatDateTime(e.created_at)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
