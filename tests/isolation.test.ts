import { describe, it, expect, beforeAll } from "vitest";
import { withTenant, withSysTx } from "../src/lib/db";
import { makeWorkspace, itemByKey, type Fixture } from "./fixtures";

let w1: Fixture;
let w2: Fixture;

beforeAll(async () => {
  w1 = await makeWorkspace();
  w2 = await makeWorkspace();
  // Internal note on client A, client-visible message on client A.
  await withSysTx(async (tx) => {
    await tx.q(
      `insert into comments (workspace_id, client_id, onboarding_id, author_user_id, visibility, body) values
       ($1,$2,$3,$4,'internal','secret internal note'), ($1,$2,$3,$4,'client','hello client')`,
      [w1.workspaceId, w1.clientA.id, w1.clientA.onboardingId, w1.staffId],
    );
  });
});

describe("company (workspace) isolation", () => {
  it("staff only see their own workspace's clients, onboardings and items", async () => {
    const res = await withTenant(w1.ctx.staff, async (tx) => ({
      clients: await tx.q<{ workspace_id: string }>("select workspace_id from clients"),
      onboardings: await tx.q<{ workspace_id: string }>("select workspace_id from onboardings"),
      items: await tx.q<{ workspace_id: string }>("select workspace_id from onboarding_items"),
      templates: await tx.q<{ workspace_id: string }>("select workspace_id from templates"),
      members: await tx.q<{ workspace_id: string }>("select workspace_id from memberships"),
    }));
    expect(res.clients.length).toBe(2);
    for (const rows of Object.values(res)) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspace_id === w1.workspaceId)).toBe(true);
    }
  });

  it("staff cannot read another workspace's record even by id", async () => {
    const row = await withTenant(w1.ctx.admin, (tx) => tx.one("select * from onboardings where id = $1", [w2.clientA.onboardingId]));
    expect(row).toBeNull();
  });

  it("staff cannot write into another workspace", async () => {
    await expect(
      withTenant(w1.ctx.admin, (tx) => tx.q("insert into clients (workspace_id, name) values ($1, 'Intruder')", [w2.workspaceId])),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(w1.ctx.admin, (tx) =>
      tx.q("update onboarding_items set status = 'approved' where onboarding_id = $1 returning id", [w2.clientA.onboardingId]),
    );
    expect(updated).toHaveLength(0);
  });

  it("a session without tenant context sees nothing", async () => {
    const rows = await withTenant({ workspaceId: "", userId: null, role: "staff" as const }, (tx) =>
      tx.q("select id from clients"),
    ).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});

describe("client isolation", () => {
  it("clients only see their own client-facing items", async () => {
    const items = await withTenant(w1.ctx.clientA, (tx) => tx.q<{ client_id: string; audience: string }>("select client_id, audience from onboarding_items"));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.client_id === w1.clientA.id && i.audience === "client")).toBe(true);
  });

  it("clients cannot read another client's onboarding by id", async () => {
    const row = await withTenant(w1.ctx.clientA, (tx) => tx.one("select * from onboardings where id = $1", [w1.clientB.onboardingId]));
    expect(row).toBeNull();
  });

  it("clients never see internal notes or internal tasks", async () => {
    const comments = await withTenant(w1.ctx.clientA, (tx) => tx.q<{ body: string }>("select body from comments"));
    expect(comments.map((c) => c.body)).toEqual(["hello client"]);
    const task = await itemByKey(w1.clientA.onboardingId, "final_creative_review");
    const row = await withTenant(w1.ctx.clientA, (tx) => tx.one("select * from onboarding_items where id = $1", [task.id]));
    expect(row).toBeNull();
  });

  it("clients cannot read templates, emails, invitations or the audit log", async () => {
    const res = await withTenant(w1.ctx.clientA, async (tx) => ({
      templates: await tx.q("select id from templates"),
      versions: await tx.q("select id from template_versions"),
      emails: await tx.q("select id from email_messages"),
      audit: await tx.q("select id from audit_events"),
      invitations: await tx.q("select id from invitations"),
      rules: await tx.q("select id from reminder_rules"),
    }));
    for (const rows of Object.values(res)) expect(rows).toHaveLength(0);
  });

  it("clients cannot modify another client's items", async () => {
    const other = await itemByKey(w1.clientB.onboardingId, "business_profile");
    const updated = await withTenant(w1.ctx.clientA, (tx) =>
      tx.q("update onboarding_items set status = 'submitted' where id = $1 returning id", [other.id]),
    );
    expect(updated).toHaveLength(0);
    expect((await itemByKey(w1.clientB.onboardingId, "business_profile")).status).toBe("not_started");
  });

  it("clients cannot approve their own items or change requirements", async () => {
    const own = await itemByKey(w1.clientA.onboardingId, "business_profile");
    await expect(
      withTenant(w1.ctx.clientA, (tx) => tx.q("update onboarding_items set status = 'approved' where id = $1", [own.id])),
    ).rejects.toThrow(/clients cannot set status/);
    await expect(
      withTenant(w1.ctx.clientA, (tx) => tx.q("update onboarding_items set status = 'in_progress', required = false where id = $1", [own.id])),
    ).rejects.toThrow(/clients may only update responses/);
  });

  it("clients cannot post internal notes or comment on another client's onboarding", async () => {
    await expect(
      withTenant(w1.ctx.clientA, (tx) =>
        tx.q(
          "insert into comments (workspace_id, client_id, onboarding_id, author_user_id, visibility, body) values ($1,$2,$3,$4,'internal','x')",
          [w1.workspaceId, w1.clientA.id, w1.clientA.onboardingId, w1.clientA.contactId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(w1.ctx.clientA, (tx) =>
        tx.q(
          "insert into comments (workspace_id, client_id, onboarding_id, author_user_id, visibility, body) values ($1,$2,$3,$4,'client','x')",
          [w1.workspaceId, w1.clientB.id, w1.clientB.onboardingId, w1.clientA.contactId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("staff cannot invite admins; only admins can", async () => {
    const { createInvitation } = await import("../src/lib/invitations");
    await expect(withTenant(w1.ctx.staff, (tx) => createInvitation(tx, w1.ctx.staff, { email: "new@x.example.com", role: "admin" }))).rejects.toThrow(/Only admins/);
    // Even bypassing the app check, the database policy blocks it.
    await expect(
      withTenant(w1.ctx.staff, (tx) =>
        tx.q("insert into invitations (workspace_id, email, role, token_hash, expires_at) values ($1, 'x@x.example.com', 'staff', 'h1', now() + interval '1 day')", [w1.workspaceId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
