import { describe, it, expect, beforeAll } from "vitest";
import { withTenant, withSysTx, sysQuery } from "../src/lib/db";
import { createInvitation } from "../src/lib/invitations";
import { acceptInvitation, lookupInvitation, createSession, resolveSession, revokeSession, revokeAllSessionsForUser } from "../src/lib/auth";
import { makeWorkspace, type Fixture } from "./fixtures";

let w: Fixture;
beforeAll(async () => {
  w = await makeWorkspace();
});

const invite = (email: string, role: "staff" | "client" = "client", ttlHours?: number) =>
  withTenant(w.ctx.admin, (tx) => createInvitation(tx, w.ctx.admin, { email, role, clientId: role === "client" ? w.clientA.id : null, ttlHours }));

describe("invitations", () => {
  it("a valid invitation creates a scoped client membership and can be used once", async () => {
    const inv = await invite("new.client@test.example.com");
    const state = await lookupInvitation(inv.token);
    expect(state.ok).toBe(true);
    const res = await acceptInvitation(inv.token, { name: "New Client", password: "long-enough-password" });
    expect(res.ok).toBe(true);
    const [m] = await sysQuery<{ role: string; client_id: string }>(
      "select m.role, m.client_id from memberships m join users u on u.id = m.user_id where u.email = 'new.client@test.example.com'",
    );
    expect(m).toEqual({ role: "client", client_id: w.clientA.id });
    const again = await acceptInvitation(inv.token, { name: "New Client", password: "long-enough-password" });
    expect(again).toEqual({ ok: false, error: "This invitation has already been used." });
    expect((await lookupInvitation(inv.token)).ok).toBe(false);
  });

  it("expired invitations are rejected", async () => {
    const inv = await invite("late@test.example.com");
    await withSysTx((tx) => tx.q("update invitations set expires_at = now() - interval '1 minute' where id = $1", [inv.id]));
    expect(await lookupInvitation(inv.token)).toEqual({ ok: false, reason: "expired" });
    const res = await acceptInvitation(inv.token, { name: "Late", password: "long-enough-password" });
    expect(res).toEqual({ ok: false, error: "This invitation has expired." });
    const users = await sysQuery("select 1 from users where email = 'late@test.example.com'");
    expect(users).toHaveLength(0);
  });

  it("invitations expire after the configured TTL", async () => {
    const inv = await invite("ttl@test.example.com", "client", 48);
    const hours = (new Date(inv.expiresAt).getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
  });

  it("re-inviting revokes the earlier link and revoked links don't work", async () => {
    const first = await invite("twice@test.example.com");
    const second = await invite("twice@test.example.com");
    expect(await lookupInvitation(first.token)).toEqual({ ok: false, reason: "revoked" });
    expect((await lookupInvitation(second.token)).ok).toBe(true);
  });

  it("unknown or tampered tokens are invalid", async () => {
    expect(await lookupInvitation("not-a-real-token")).toEqual({ ok: false, reason: "invalid" });
  });

  it("weak passwords are refused", async () => {
    const inv = await invite("weak@test.example.com");
    const res = await acceptInvitation(inv.token, { name: "Weak", password: "short" });
    expect(res.ok).toBe(false);
  });
});

describe("sessions", () => {
  it("sessions resolve to the right role and can be revoked", async () => {
    const inv = await invite("session.user@test.example.com");
    const accepted = await acceptInvitation(inv.token, { name: "Sess", password: "long-enough-password" });
    if (!accepted.ok) throw new Error("accept failed");
    const s1 = await createSession(accepted.userId, w.workspaceId);
    const s2 = await createSession(accepted.userId, w.workspaceId);
    const auth = await resolveSession(s1.token);
    expect(auth?.role).toBe("client");
    expect(auth?.clientId).toBe(w.clientA.id);
    await revokeSession(s1.sessionId, accepted.userId);
    expect(await resolveSession(s1.token)).toBeNull();
    expect(await resolveSession(s2.token)).not.toBeNull();
    await revokeAllSessionsForUser(accepted.userId);
    expect(await resolveSession(s2.token)).toBeNull();
  });

  it("expired sessions and removed members are signed out", async () => {
    const s = await createSession(w.staffId, w.workspaceId);
    await sysQuery("update sessions set expires_at = now() - interval '1 second' where id = $1", [s.sessionId]);
    expect(await resolveSession(s.token)).toBeNull();
    const extra = await makeWorkspace();
    const s2 = await createSession(extra.staffId, extra.workspaceId);
    expect(await resolveSession(s2.token)).not.toBeNull();
    await sysQuery("delete from memberships where user_id = $1", [extra.staffId]);
    expect(await resolveSession(s2.token)).toBeNull();
  });
});
