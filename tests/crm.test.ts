import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { withSysTx, withTenant } from "../src/lib/db";
import { hubSpotWonDealIds, importClosedWonDeal, normalizeGeneric, verifyBasicAuth, verifyHubSpotSignature, verifySignedBody } from "../src/lib/integrations/crm";
import { makeWorkspace, type Fixture } from "./fixtures";

describe("webhook verification", () => {
  it("accepts only correctly signed generic deal payloads", () => {
    const body = JSON.stringify({ event: "deal.closed_won" });
    const sig = crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignedBody("s3cret", body, `sha256=${sig}`)).toBe(true);
    expect(verifySignedBody("s3cret", body + " ", `sha256=${sig}`)).toBe(false);
    expect(verifySignedBody("other", body, sig)).toBe(false);
    expect(verifySignedBody("s3cret", body, null)).toBe(false);
  });

  it("verifies HubSpot v3 signatures and rejects stale timestamps", () => {
    const now = Date.now();
    const input = { method: "POST", uri: "https://app.example.com/api/integrations/hubspot/webhook?workspace=w", body: "[]", timestamp: String(now) };
    const signature = crypto.createHmac("sha256", "client-secret").update(`${input.method}${input.uri}${input.body}${input.timestamp}`).digest("base64");
    expect(verifyHubSpotSignature("client-secret", { ...input, signature }, now)).toBe(true);
    expect(verifyHubSpotSignature("wrong", { ...input, signature }, now)).toBe(false);
    expect(verifyHubSpotSignature("client-secret", { ...input, signature }, now + 6 * 60_000)).toBe(false);
  });

  it("verifies Pipedrive basic auth", () => {
    const header = "Basic " + Buffer.from("clientflow:pw-123").toString("base64");
    expect(verifyBasicAuth(header, "pw-123")).toBe(true);
    expect(verifyBasicAuth(header, "nope")).toBe(false);
    expect(verifyBasicAuth(null, "pw-123")).toBe(false);
  });

  it("picks only deals that moved to the won stage", () => {
    expect(
      hubSpotWonDealIds([
        { subscriptionType: "deal.propertyChange", propertyName: "dealstage", propertyValue: "closedwon", objectId: 1 },
        { subscriptionType: "deal.propertyChange", propertyName: "dealstage", propertyValue: "appointmentscheduled", objectId: 2 },
        { subscriptionType: "deal.propertyChange", propertyName: "dealstage", propertyValue: "closedwon", objectId: 1 },
      ]),
    ).toEqual(["1"]);
  });

  it("rejects malformed generic payloads", () => {
    expect(() => normalizeGeneric("salesforce", { event: "deal.closed_won", deal: {}, company: {} })).toThrow();
  });
});

describe("closed-won import", () => {
  let w: Fixture;
  beforeAll(async () => {
    w = await makeWorkspace();
    await withSysTx(async (tx) => {
      const tpl = await tx.one<{ id: string }>("select id from templates where workspace_id = $1", [w.workspaceId]);
      await tx.q("insert into client_types (workspace_id, name, template_id, default_owner_user_id) values ($1, 'Paid Ads', $2, $3)", [
        w.workspaceId,
        tpl!.id,
        w.staffId,
      ]);
      await tx.q(
        `insert into automation_rules (workspace_id, name, enabled, trigger, actions, run_mode) values ($1, 'Won deal', true, 'deal_imported', $2, 'every_event')`,
        [w.workspaceId, JSON.stringify([{ type: "create_onboarding" }, { type: "assign_owner", owner: "client_type_default" }, { type: "invite_client" }])],
      );
    });
  });

  const deal = {
    provider: "hubspot",
    externalId: "D-1",
    dealName: "Johnson Dental retainer",
    companyName: "Johnson Dental",
    contactName: "John",
    contactEmail: "john@johnson.example.com",
    amount: 15000,
    recurrence: "monthly" as const,
    serviceType: "paid ads",
  };

  it("creates the client, contact and onboarding from the service's template, and invites the client", async () => {
    const r = await importClosedWonDeal(w.workspaceId, deal);
    expect(r.status).toBe("created");
    const c = await withTenant(w.ctx.admin, (tx) =>
      tx.one<{ deal_amount: string; deal_recurrence: string; source: string }>("select deal_amount, deal_recurrence, source from clients where id = $1", [r.clientId]),
    );
    expect(Number(c!.deal_amount)).toBe(15000);
    expect(c!.source).toBe("hubspot");
    const onb = await withTenant(w.ctx.admin, (tx) => tx.q<{ owner_user_id: string; source: string }>("select owner_user_id, source from onboardings where client_id = $1", [r.clientId]));
    expect(onb).toHaveLength(1);
    expect(onb[0].owner_user_id).toBe(w.staffId);
    const invites = await withTenant(w.ctx.admin, (tx) => tx.q("select 1 from invitations where client_id = $1", [r.clientId]));
    expect(invites).toHaveLength(1);
    // Demo workspace: the invitation email is recorded, never sent.
    const mail = await withTenant(w.ctx.admin, (tx) => tx.q<{ status: string }>("select status from email_messages where kind = 'invitation' and to_email = $1", [deal.contactEmail]));
    expect(mail.map((m) => m.status)).toEqual(["simulated"]);
  });

  it("the same deal delivered twice creates nothing new", async () => {
    const r = await importClosedWonDeal(w.workspaceId, deal);
    expect(r.status).toBe("duplicate");
    const clients = await withTenant(w.ctx.admin, (tx) => tx.q("select 1 from clients where name = 'Johnson Dental'"));
    expect(clients).toHaveLength(1);
    const onbs = await withTenant(w.ctx.admin, (tx) => tx.q("select 1 from onboardings o join clients c on c.id = o.client_id where c.name = 'Johnson Dental'"));
    expect(onbs).toHaveLength(1);
  });
});
