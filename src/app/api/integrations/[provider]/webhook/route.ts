import { NextResponse, type NextRequest } from "next/server";
import { sysQuery, withTenant } from "@/lib/db";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { systemCtx } from "@/lib/automation/engine";
import { loadIntegration, recordIntegrationEvent, setIntegrationStatus } from "@/lib/integrations/store";
import {
  fetchHubSpotDeal,
  hubSpotWonDealIds,
  importClosedWonDeal,
  normalizeGeneric,
  normalizePipedrive,
  pipedriveWonDeal,
  verifyBasicAuth,
  verifyHubSpotSignature,
  verifySignedBody,
  type ClosedWonDeal,
  type HubSpotEvent,
} from "@/lib/integrations/crm";

export const dynamic = "force-dynamic";

/** URL segment → provider id stored in `integrations`. "generic" is an alias for the signed-webhook provider. */
const PROVIDER_ALIASES: Record<string, string> = { hubspot: "hubspot", pipedrive: "pipedrive", salesforce: "salesforce", webhook: "webhook", generic: "webhook" };

const json = (body: unknown, status = 200, headers?: Record<string, string>) => NextResponse.json(body, { status, headers });

async function record(workspaceId: string, provider: string, status: "failed" | "ignored", detail: string, externalId?: string | null) {
  try {
    await withTenant(systemCtx(workspaceId), (tx) =>
      recordIntegrationEvent(tx, { workspaceId, provider, direction: "inbound", eventType: "webhook", status, detail, externalId: externalId ?? null }),
    );
  } catch (e) {
    console.error(`[webhook:${provider}] could not record integration event`, e instanceof Error ? e.message : e);
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Inbound CRM webhooks: POST /api/integrations/<provider>/webhook?workspace=<slug>.
 * Every request is authenticated per provider (HMAC signature or basic auth) against credentials stored
 * encrypted for that workspace. Deals are imported at most once (deduplicated by provider + external id).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: segment } = await params;
  const provider = PROVIDER_ALIASES[segment];
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const limit = await rateLimit(`webhook:${segment}:${ip}`, 120, 60_000);
  if (!limit.ok) return json({ error: "rate_limited" }, 429, { "Retry-After": String(limit.retryAfterSeconds) });
  if (!provider) return json({ error: "unknown_provider" }, 404);

  const slug = req.nextUrl.searchParams.get("workspace")?.trim();
  if (!slug) return json({ error: "missing_workspace", hint: "Append ?workspace=<your workspace slug> to the webhook URL." }, 404);
  const [ws] = await sysQuery<{ id: string; is_demo: boolean }>("select id, is_demo from workspaces where slug = $1", [slug]);
  if (!ws) return json({ error: "unknown_workspace" }, 404);
  if (ws.is_demo)
    return json({ error: "demo_workspace", message: "Demo workspaces don't accept live CRM webhooks. Use the simulation on the Integrations page." }, 403);

  const rawBody = await req.text();
  if (rawBody.length > 1_000_000) return json({ error: "payload_too_large" }, 413);
  const conn = await loadIntegration(ws.id, provider);
  if (!conn) {
    await record(ws.id, provider, "failed", "Webhook received but this integration is not configured.");
    return json({ error: "not_configured" }, 404);
  }

  let body: unknown;
  const parse = () => {
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
      return true;
    } catch {
      return false;
    }
  };

  let deals: ClosedWonDeal[] = [];
  try {
    if (provider === "hubspot") {
      const secret = conn.secrets.clientSecret;
      const input = {
        method: "POST",
        body: rawBody,
        timestamp: req.headers.get("x-hubspot-request-timestamp"),
        signature: req.headers.get("x-hubspot-signature-v3"),
      };
      // HubSpot signs the public URI it called; behind a proxy that is APP_URL + path, not the internal URL.
      const publicUri = `${env.appUrl}${req.nextUrl.pathname}${req.nextUrl.search}`;
      const ok = !!secret && (verifyHubSpotSignature(secret, { ...input, uri: publicUri }) || verifyHubSpotSignature(secret, { ...input, uri: req.url }));
      if (!ok) {
        await record(ws.id, provider, "failed", "Rejected: HubSpot signature did not verify (or the request was older than 5 minutes).");
        return json({ error: "invalid_signature" }, 401);
      }
      if (!parse() || !Array.isArray(body)) {
        await record(ws.id, provider, "failed", "Rejected: HubSpot payload is not a JSON array of events.");
        return json({ error: "invalid_payload" }, 400);
      }
      const ids = hubSpotWonDealIds(body as HubSpotEvent[], conn.config.wonStage || "closedwon");
      if (!conn.secrets.accessToken && ids.length) throw new Error("HubSpot access token is missing; deal details can't be fetched.");
      for (const id of ids) deals.push(await fetchHubSpotDeal(conn.secrets.accessToken, id, conn.config.serviceProperty || "service_type"));
    } else if (provider === "pipedrive") {
      if (!conn.secrets.webhookPassword || !verifyBasicAuth(req.headers.get("authorization"), conn.secrets.webhookPassword)) {
        await record(ws.id, provider, "failed", "Rejected: Pipedrive basic-auth credentials did not match.");
        return json({ error: "invalid_signature" }, 401);
      }
      if (!parse()) {
        await record(ws.id, provider, "failed", "Rejected: payload is not valid JSON.");
        return json({ error: "invalid_payload" }, 400);
      }
      const won = pipedriveWonDeal(body);
      if (won) deals = [await normalizePipedrive(won, conn.secrets.apiToken || undefined)];
    } else {
      const header = req.headers.get("x-clientflow-signature");
      if (!conn.secrets.signingSecret || !verifySignedBody(conn.secrets.signingSecret, rawBody, header)) {
        await record(ws.id, provider, "failed", "Rejected: X-ClientFlow-Signature did not verify.");
        return json({ error: "invalid_signature" }, 401);
      }
      if (!parse()) {
        await record(ws.id, provider, "failed", "Rejected: payload is not valid JSON.");
        return json({ error: "invalid_payload" }, 400);
      }
      try {
        deals = [normalizeGeneric(provider, body)];
      } catch {
        await record(ws.id, provider, "failed", "Rejected: payload doesn't match the deal.closed_won format.");
        return json({ error: "invalid_payload", message: "Expected { event: 'deal.closed_won', deal, company, contact? }." }, 422);
      }
    }
  } catch (e) {
    // Authenticated but a follow-up lookup failed (for example the CRM API). Record it so it is visible on the Integrations page.
    const msg = errorMessage(e);
    await record(ws.id, provider, "failed", `Could not read the deal: ${msg}`);
    await setIntegrationStatus(ws.id, provider, "error", { error: msg, event: true });
    return json({ error: "processing_failed" }, 502);
  }

  // The request was authenticated: the integration is verified end to end.
  await setIntegrationStatus(ws.id, provider, "connected", { event: true });
  if (deals.length === 0) {
    await record(ws.id, provider, "ignored", "Signed webhook received; no closed-won deal in it.");
    return json({ ok: true, imported: 0, results: [] });
  }

  const results: { externalId: string; status: string; clientId?: string | null; error?: string }[] = [];
  for (const deal of deals) {
    try {
      const r = await importClosedWonDeal(ws.id, deal);
      results.push({ externalId: deal.externalId, status: r.status, clientId: r.clientId });
    } catch (e) {
      const msg = errorMessage(e);
      await record(ws.id, provider, "failed", `Import of deal ${deal.externalId} failed: ${msg}`, null);
      results.push({ externalId: deal.externalId, status: "failed", error: "import_failed" });
    }
  }
  return json({ ok: results.every((r) => r.status !== "failed"), imported: results.filter((r) => r.status === "created" || r.status === "existing_client").length, results });
}
