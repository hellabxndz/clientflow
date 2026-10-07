import { z } from "zod";
import { withTenant } from "../db";
import { audit } from "../audit";
import { isValidTimeZone } from "../time";
import { emitEvent, processPendingEvents, systemCtx } from "../automation/engine";
import { callApi, recordIntegrationEvent } from "./store";
import { hmacSha256, safeEqual } from "./crypto";

/** The shape every CRM adapter normalizes a closed-won deal into. */
export interface ClosedWonDeal {
  provider: string;
  externalId: string;
  dealName: string;
  companyName: string;
  website?: string | null;
  industry?: string | null;
  timezone?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  amount?: number | null;
  recurrence?: "one_time" | "monthly" | "annual";
  serviceType?: string | null;
  ownerEmail?: string | null;
}

// ---------------------------------------------------------------------------
// ClientFlow's own signed format (used by Salesforce Flows, Zapier, Make, custom systems)
// ---------------------------------------------------------------------------

export const genericDealSchema = z.object({
  event: z.literal("deal.closed_won"),
  deal: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().min(1).max(300),
    amount: z.number().nonnegative().nullable().optional(),
    recurrence: z.enum(["one_time", "monthly", "annual"]).optional(),
    service: z.string().max(120).nullable().optional(),
  }),
  company: z.object({
    name: z.string().min(1).max(300),
    website: z.string().max(300).nullable().optional(),
    industry: z.string().max(120).nullable().optional(),
    timezone: z.string().max(60).nullable().optional(),
  }),
  contact: z
    .object({ name: z.string().max(200).nullable().optional(), email: z.string().email().nullable().optional(), phone: z.string().max(60).nullable().optional() })
    .optional(),
  owner_email: z.string().email().nullable().optional(),
});

export function normalizeGeneric(provider: string, body: unknown): ClosedWonDeal {
  const p = genericDealSchema.parse(body);
  return {
    provider,
    externalId: p.deal.id,
    dealName: p.deal.name,
    companyName: p.company.name,
    website: p.company.website ?? null,
    industry: p.company.industry ?? null,
    timezone: p.company.timezone ?? null,
    contactName: p.contact?.name ?? null,
    contactEmail: p.contact?.email ?? null,
    contactPhone: p.contact?.phone ?? null,
    amount: p.deal.amount ?? null,
    recurrence: p.deal.recurrence ?? "one_time",
    serviceType: p.deal.service ?? null,
    ownerEmail: p.owner_email ?? null,
  };
}

export function verifySignedBody(secret: string, rawBody: string, header: string | null) {
  if (!header) return false;
  const sig = header.replace(/^sha256=/, "");
  return safeEqual(sig, hmacSha256(secret, rawBody, "hex"));
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

/** Verifies X-HubSpot-Signature-v3: base64 HMAC-SHA256 of method + uri + body + timestamp, at most 5 minutes old. */
export function verifyHubSpotSignature(
  clientSecret: string,
  input: { method: string; uri: string; body: string; timestamp: string | null; signature: string | null },
  now = Date.now(),
) {
  if (!input.signature || !input.timestamp) return false;
  if (Math.abs(now - Number(input.timestamp)) > 5 * 60 * 1000) return false;
  const expected = hmacSha256(clientSecret, `${input.method}${input.uri}${input.body}${input.timestamp}`, "base64");
  return safeEqual(expected, input.signature);
}

export interface HubSpotEvent {
  subscriptionType?: string;
  objectId?: number | string;
  propertyName?: string;
  propertyValue?: string;
  eventId?: number | string;
}

/** Deal ids from a HubSpot webhook batch whose dealstage changed to the won stage. */
export function hubSpotWonDealIds(events: HubSpotEvent[], wonStage = "closedwon") {
  return [
    ...new Set(
      events
        .filter((e) => e.subscriptionType === "deal.propertyChange" && e.propertyName === "dealstage" && e.propertyValue === wonStage)
        .map((e) => String(e.objectId)),
    ),
  ];
}

export async function fetchHubSpotDeal(accessToken: string, dealId: string, serviceProperty = "service_type"): Promise<ClosedWonDeal> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const base = "https://api.hubapi.com/crm/v3/objects";
  const { json: deal } = await callApi(
    `${base}/deals/${encodeURIComponent(dealId)}?properties=dealname,amount,hs_mrr,hubspot_owner_id,${encodeURIComponent(serviceProperty)}&associations=companies,contacts`,
    { headers: auth },
  );
  const d = deal as {
    properties: Record<string, string | null>;
    associations?: { companies?: { results: { id: string }[] }; contacts?: { results: { id: string }[] } };
  };
  const companyId = d.associations?.companies?.results?.[0]?.id;
  const contactId = d.associations?.contacts?.results?.[0]?.id;
  const company = companyId
    ? ((await callApi(`${base}/companies/${companyId}?properties=name,domain,industry`, { headers: auth })).json as { properties: Record<string, string | null> }).properties
    : {};
  const contact = contactId
    ? ((await callApi(`${base}/contacts/${contactId}?properties=firstname,lastname,email,phone`, { headers: auth })).json as { properties: Record<string, string | null> }).properties
    : {};
  let ownerEmail: string | null = null;
  if (d.properties.hubspot_owner_id) {
    const { json } = await callApi(`https://api.hubapi.com/crm/v3/owners/${d.properties.hubspot_owner_id}`, { headers: auth }).catch(() => ({ json: null }));
    ownerEmail = (json as { email?: string } | null)?.email ?? null;
  }
  const mrr = d.properties.hs_mrr ? Number(d.properties.hs_mrr) : null;
  return {
    provider: "hubspot",
    externalId: dealId,
    dealName: d.properties.dealname ?? `HubSpot deal ${dealId}`,
    companyName: company.name ?? d.properties.dealname ?? `HubSpot deal ${dealId}`,
    website: company.domain ? `https://${company.domain}` : null,
    industry: company.industry ?? null,
    contactName: [contact.firstname, contact.lastname].filter(Boolean).join(" ") || null,
    contactEmail: contact.email ?? null,
    contactPhone: contact.phone ?? null,
    amount: mrr ?? (d.properties.amount ? Number(d.properties.amount) : null),
    recurrence: mrr ? "monthly" : "one_time",
    serviceType: d.properties[serviceProperty] ?? null,
    ownerEmail,
  };
}

// ---------------------------------------------------------------------------
// Pipedrive
// ---------------------------------------------------------------------------

export function verifyBasicAuth(header: string | null, password: string, user = "clientflow") {
  if (!header?.startsWith("Basic ")) return false;
  const expected = Buffer.from(`${user}:${password}`).toString("base64");
  return safeEqual(header.slice(6), expected);
}

interface PipedriveDeal {
  id: number | string;
  title?: string;
  status?: string;
  value?: number;
  org_id?: number | { value?: number; name?: string } | null;
  person_id?: number | { value?: number; name?: string; email?: { value: string }[] } | null;
  org_name?: string;
  person_name?: string;
}

/** Returns the won deal when a Pipedrive webhook (v1 or v2 payload) reports a transition to "won". */
export function pipedriveWonDeal(body: unknown): PipedriveDeal | null {
  const b = body as { data?: PipedriveDeal; current?: PipedriveDeal; previous?: { status?: string } | null; meta?: { entity?: string; object?: string } };
  const entity = b.meta?.entity ?? b.meta?.object;
  if (entity && entity !== "deal") return null;
  const current = b.data ?? b.current;
  if (!current || current.status !== "won") return null;
  if (b.previous && b.previous.status === "won") return null;
  return current;
}

export async function normalizePipedrive(deal: PipedriveDeal, apiToken?: string): Promise<ClosedWonDeal> {
  const orgRef = typeof deal.org_id === "object" && deal.org_id ? deal.org_id : null;
  const personRef = typeof deal.person_id === "object" && deal.person_id ? deal.person_id : null;
  let companyName = deal.org_name ?? orgRef?.name ?? null;
  let contactName = deal.person_name ?? personRef?.name ?? null;
  let contactEmail = personRef?.email?.[0]?.value ?? null;
  const orgId = orgRef?.value ?? (typeof deal.org_id === "number" ? deal.org_id : null);
  const personId = personRef?.value ?? (typeof deal.person_id === "number" ? deal.person_id : null);
  if (apiToken && orgId && !companyName) {
    const { json } = await callApi(`https://api.pipedrive.com/v1/organizations/${orgId}?api_token=${encodeURIComponent(apiToken)}`);
    companyName = (json as { data?: { name?: string } })?.data?.name ?? null;
  }
  if (apiToken && personId && (!contactName || !contactEmail)) {
    const { json } = await callApi(`https://api.pipedrive.com/v1/persons/${personId}?api_token=${encodeURIComponent(apiToken)}`);
    const p = (json as { data?: { name?: string; email?: { value: string }[] } })?.data;
    contactName ??= p?.name ?? null;
    contactEmail ??= p?.email?.[0]?.value ?? null;
  }
  return {
    provider: "pipedrive",
    externalId: String(deal.id),
    dealName: deal.title ?? `Pipedrive deal ${deal.id}`,
    companyName: companyName ?? deal.title ?? `Pipedrive deal ${deal.id}`,
    contactName,
    contactEmail,
    amount: deal.value ?? null,
    recurrence: "one_time",
  };
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

export type ImportDealResult =
  | { status: "created"; clientId: string }
  | { status: "existing_client"; clientId: string }
  | { status: "duplicate"; clientId: string | null };

/**
 * Turns a closed-won deal into a client and a `deal_imported` event. Automation rules listening
 * for that event create the onboarding, assign the owner, invite the client and so on.
 * Each deal is imported at most once.
 */
export async function importClosedWonDeal(workspaceId: string, deal: ClosedWonDeal, opts: { simulated?: boolean } = {}) {
  const result = await withTenant(systemCtx(workspaceId), async (tx): Promise<ImportDealResult> => {
    const seen = await tx.one<{ client_id: string | null }>(
      `select client_id from integration_events where provider = $1 and external_id = $2 and direction = 'inbound' and status in ('processed', 'simulated')`,
      [deal.provider, deal.externalId],
    );
    if (seen) {
      await recordIntegrationEvent(tx, {
        workspaceId,
        provider: deal.provider,
        direction: "inbound",
        eventType: "deal.closed_won",
        status: "duplicate",
        detail: `Deal ${deal.externalId} was already imported`,
        clientId: seen.client_id,
      });
      return { status: "duplicate", clientId: seen.client_id };
    }
    const type = deal.serviceType
      ? await tx.one<{ id: string }>("select id from client_types where lower(name) = lower($1)", [deal.serviceType.trim()])
      : null;
    const owner = deal.ownerEmail
      ? await tx.one<{ user_id: string }>(
          "select m.user_id from memberships m join users u on u.id = m.user_id where lower(u.email) = lower($1) and m.role <> 'client'",
          [deal.ownerEmail],
        )
      : null;
    const existing = await tx.one<{ id: string }>(
      "select id from clients where archived_at is null and (lower(name) = lower($1) or (source = $2 and external_id = $3)) limit 1",
      [deal.companyName.trim(), deal.provider, deal.externalId],
    );
    let clientId: string;
    let status: ImportDealResult["status"];
    if (existing) {
      clientId = existing.id;
      status = "existing_client";
      await tx.q(
        `update clients set deal_amount = coalesce($2, deal_amount), deal_recurrence = coalesce($3, deal_recurrence),
           client_type_id = coalesce(client_type_id, $4), owner_user_id = coalesce(owner_user_id, $5) where id = $1`,
        [clientId, deal.amount ?? null, deal.recurrence ?? null, type?.id ?? null, owner?.user_id ?? null],
      );
    } else {
      const tz = deal.timezone && isValidTimeZone(deal.timezone) ? deal.timezone : null;
      const row = await tx.one<{ id: string }>(
        `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id,
           client_type_id, deal_amount, deal_recurrence, source, external_id)
         values ($1,$2,$3,$4,coalesce($5, (select timezone from workspaces where id = $1)),$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [workspaceId, deal.companyName.trim().slice(0, 200), deal.industry ?? null, deal.website ?? null, tz, deal.contactName ?? null,
         deal.contactEmail ?? null, owner?.user_id ?? null, type?.id ?? null, deal.amount ?? null, deal.recurrence ?? "one_time", deal.provider, deal.externalId],
      );
      clientId = row!.id;
      status = "created";
      if (deal.contactName || deal.contactEmail)
        await tx.q(
          `insert into client_contacts (workspace_id, client_id, name, email, contact_role, phone) values ($1,$2,$3,$4,'primary',$5)
           on conflict (client_id, email) do nothing`,
          [workspaceId, clientId, deal.contactName ?? deal.contactEmail, deal.contactEmail ?? null, deal.contactPhone ?? null],
        );
    }
    await recordIntegrationEvent(tx, {
      workspaceId,
      provider: deal.provider,
      direction: "inbound",
      eventType: "deal.closed_won",
      status: opts.simulated ? "simulated" : "processed",
      detail: `${opts.simulated ? "Demo simulation: " : ""}${deal.dealName}${deal.amount ? ` ($${deal.amount.toLocaleString("en-US")}${deal.recurrence === "monthly" ? "/mo" : deal.recurrence === "annual" ? "/yr" : ""})` : ""}`,
      externalId: deal.externalId,
      clientId,
    });
    await emitEvent(tx, {
      workspace_id: workspaceId,
      type: "deal_imported",
      client_id: clientId,
      onboarding_id: null,
      item_id: null,
      payload: { provider: deal.provider, dealName: deal.dealName, amount: deal.amount ?? null, simulated: !!opts.simulated },
      dedupeKey: `deal:${deal.provider}:${deal.externalId}`,
    });
    await audit(tx, systemCtx(workspaceId), "deal.imported", "client", clientId,
      `${opts.simulated ? "Simulated " : ""}closed-won deal "${deal.dealName}" received from ${deal.provider}`, { externalId: deal.externalId });
    return { status, clientId };
  });
  if (result.status !== "duplicate") await processPendingEvents({ workspaceId });
  return result;
}
