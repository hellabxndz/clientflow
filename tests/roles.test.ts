import { describe, it, expect, beforeAll } from "vitest";
import { withSysTx, withTenant, type TenantContext } from "../src/lib/db";
import { can } from "../src/lib/permissions";
import { notify } from "../src/lib/notifications";
import { connectionState, saveIntegration } from "../src/lib/integrations/store";
import { providerById } from "../src/lib/integrations/catalog";
import { decryptSecrets } from "../src/lib/integrations/crypto";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;
let other: Fixture;
let manager: TenantContext;

const rule = (wsId: string) => [
  wsId,
  "Notify",
  "item_submitted",
  JSON.stringify([{ type: "notify_staff", to: "onboarding_owner", message: "x" }]),
];
const insertRule = "insert into automation_rules (workspace_id, name, trigger, actions) values ($1, $2, $3, $4) returning id";

beforeAll(async () => {
  w = await makeWorkspace();
  other = await makeWorkspace();
  const managerId = await withSysTx(async (tx) => {
    const id = (await tx.one<{ id: string }>("insert into users (email, name) values ($1, 'Manager') returning id", [`mgr-${Date.now()}@test.example.com`]))!.id;
    await tx.q("insert into memberships (workspace_id, user_id, role, can_approve) values ($1, $2, 'manager', true)", [w.workspaceId, id]);
    return id;
  });
  manager = { workspaceId: w.workspaceId, userId: managerId, role: "manager" };
});

describe("role permissions", () => {
  it("the permission table matches the product's roles", () => {
    expect(can("admin", "manageIntegrations")).toBe(true);
    expect(can("manager", "manageIntegrations")).toBe(false);
    expect(can("manager", "manageAutomations")).toBe(true);
    expect(can("staff", "manageAutomations")).toBe(false);
    expect(can("staff", "manageTeam")).toBe(false);
    expect(can("client", "reassignReviews")).toBe(false);
  });

  it("managers and admins can create automation rules; staff and clients cannot", async () => {
    await expect(withTenant(manager, (tx) => tx.q(insertRule, rule(w.workspaceId)))).resolves.toHaveLength(1);
    await expect(withTenant(w.ctx.admin, (tx) => tx.q(insertRule, rule(w.workspaceId)))).resolves.toHaveLength(1);
    await expect(withTenant(w.ctx.staff, (tx) => tx.q(insertRule, rule(w.workspaceId)))).rejects.toThrow(/row-level security/);
    await expect(withTenant(w.ctx.clientA, (tx) => tx.q(insertRule, rule(w.workspaceId)))).rejects.toThrow(/row-level security|permission denied/);
  });

  it("staff can read rules but can't change them; nobody but the engine writes run records", async () => {
    expect((await withTenant(w.ctx.staff, (tx) => tx.q("select id from automation_rules"))).length).toBeGreaterThan(0);
    const updated = await withTenant(w.ctx.staff, (tx) => tx.q("update automation_rules set enabled = false returning id"));
    expect(updated).toHaveLength(0);
    const [r] = await withTenant(w.ctx.admin, (tx) => tx.q<{ id: string }>("select id from automation_rules limit 1"));
    await expect(
      withTenant(w.ctx.admin, (tx) =>
        tx.q("insert into automation_runs (workspace_id, rule_id, dedupe_key, trigger, status) values ($1, $2, 'x', 'item_submitted', 'succeeded')", [
          w.workspaceId,
          r.id,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("only admins can change integrations, and credentials are never readable by the app role", async () => {
    await expect(
      withTenant(manager, (tx) => tx.q("insert into integrations (workspace_id, provider) values ($1, 'slack')", [w.workspaceId])),
    ).rejects.toThrow(/row-level security|permission denied/);
    await saveIntegration(w.workspaceId, "slack", { webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXX" }, w.adminId);
    await expect(withTenant(w.ctx.admin, (tx) => tx.q("select secrets_enc from integrations"))).rejects.toThrow(/permission denied/);
    const [row] = await withSysTx((tx) => tx.q<{ secrets_enc: string; status: string }>("select secrets_enc, status from integrations where workspace_id = $1", [w.workspaceId]));
    expect(row.secrets_enc).not.toContain("hooks.slack.com");
    expect(decryptSecrets(row.secrets_enc).webhookUrl).toContain("hooks.slack.com");
    // Saved credentials are "Configuration Required" until a real test succeeds — never shown as connected.
    expect(row.status).toBe("configured");
    const visible = await withTenant(w.ctx.staff, (tx) => tx.q("select provider, status from integrations"));
    expect(visible).toHaveLength(1);
    expect(await withTenant(other.ctx.admin, (tx) => tx.q("select provider from integrations"))).toHaveLength(0);
  });

  it("integration cards report honest states", () => {
    const hubspot = providerById("hubspot")!;
    expect(connectionState(hubspot, undefined).state).toBe("not_connected");
    expect(connectionState(hubspot, { status: "configured" } as never).state).toBe("configuration_required");
    expect(connectionState(providerById("quickbooks")!, undefined).state).toBe("coming_soon");
  });

  it("clients can't see rules, runs, integrations, imports or notifications", async () => {
    for (const table of ["automation_rules", "automation_runs", "integrations", "imports", "notifications", "client_types"]) {
      const rows = await withTenant(w.ctx.clientA, (tx) => tx.q(`select 1 from ${table}`)).catch(() => []);
      expect(rows, table).toHaveLength(0);
    }
  });

  it("notifications are private to their recipient and can't target other workspaces", async () => {
    const ws = { id: w.workspaceId, name: "W", is_demo: true, email_from_name: null };
    const created = await withTenant(w.ctx.admin, (tx) => notify(tx, { workspace: ws, userIds: [w.staffId, other.staffId, w.clientA.contactId], title: "Hello" }));
    // Only the staff member of this workspace gets it; the other workspace's user and the client contact are skipped.
    expect(created).toBe(1);
    expect(await withTenant(w.ctx.staff, (tx) => tx.q("select 1 from notifications"))).toHaveLength(1);
    expect(await withTenant(w.ctx.admin, (tx) => tx.q("select 1 from notifications"))).toHaveLength(0);
    expect(await withTenant(other.ctx.staff, (tx) => tx.q("select 1 from notifications"))).toHaveLength(0);
    await expect(
      withTenant(w.ctx.clientA, (tx) => tx.q("select app.create_notification($1, 'info', 't', null, null, null, null)", [w.staffId])),
    ).rejects.toThrow(/only staff/);
  });

  it("staff in one workspace can't read another workspace's automation history or audit trail", async () => {
    expect(await withTenant(other.ctx.admin, (tx) => tx.q("select 1 from automation_rules"))).toHaveLength(0);
    expect(await withTenant(other.ctx.admin, (tx) => tx.q("select 1 from item_status_history where workspace_id = $1", [w.workspaceId]))).toHaveLength(0);
    expect(await withTenant(other.ctx.admin, (tx) => tx.q("select 1 from audit_events where workspace_id = $1", [w.workspaceId]))).toHaveLength(0);
  });
});
