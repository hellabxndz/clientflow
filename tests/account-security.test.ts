import { describe, it, expect, beforeAll } from "vitest";
import { sysQuery, withSysTx } from "../src/lib/db";
import { base32Decode, base32Encode, beginEnrollment, confirmEnrollment, currentStep, matchTotp, totpAt, verifyMfa, recoveryCodesLeft } from "../src/lib/mfa";
import { completePasswordReset, lookupReset, requestPasswordReset } from "../src/lib/password-reset";
import { createSession, hashPassword, resolveSession, verifyCredentials } from "../src/lib/auth";
import { randomToken, sha256 } from "../src/lib/tokens";
import { uploadDocument } from "../src/lib/files";
import { makeWorkspace, itemByKey, PDF, type Fixture } from "./fixtures";

let w: Fixture;
let email: string;

beforeAll(async () => {
  w = await makeWorkspace();
  email = (await sysQuery<{ email: string }>("select email from users where id = $1", [w.staffId]))[0].email;
  await sysQuery("update users set password_hash = $2 where id = $1", [w.staffId, await hashPassword("original-password-1")]);
});

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC 6238 appendix B, truncated to 6 digits.
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpAt(secret, Math.floor(2000000000 / 30))).toBe("279037");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });

  it("accepts one step of clock drift and nothing further", () => {
    const secret = base32Encode(Buffer.from("abcdefghijabcdefghij"));
    const now = Date.now();
    const step = currentStep(now);
    expect(matchTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, totpAt(secret, step - 3), now)).toBeNull();
    expect(matchTotp(secret, "12ab56", now)).toBeNull();
  });
});

describe("two-step sign-in", () => {
  let secret: string;
  let recovery: string[];

  it("is off until enrollment is confirmed with a valid code", async () => {
    secret = await beginEnrollment(w.staffId);
    expect(await verifyMfa(w.staffId, totpAt(secret, currentStep()))).toBeNull();
    expect(await confirmEnrollment(w.staffId, "000000")).toBeNull();
    const codes = await confirmEnrollment(w.staffId, totpAt(secret, currentStep() - 1));
    expect(codes).toHaveLength(8);
    recovery = codes!;
    const auth = await resolveSession((await createSession(w.staffId, w.workspaceId)).token);
    expect(auth!.user.mfa_enabled).toBe(true);
  });

  it("accepts each code only once", async () => {
    const code = totpAt(secret, currentStep());
    expect(await verifyMfa(w.staffId, code)).toBe("totp");
    expect(await verifyMfa(w.staffId, code)).toBeNull();
    // An older code than one already used is refused too.
    expect(await verifyMfa(w.staffId, totpAt(secret, currentStep() - 1))).toBeNull();
  });

  it("recovery codes work once each", async () => {
    expect(await verifyMfa(w.staffId, recovery[0].toUpperCase())).toBe("recovery");
    expect(await verifyMfa(w.staffId, recovery[0])).toBeNull();
    expect(await recoveryCodesLeft(w.staffId)).toBe(7);
  });

  it("the secret is encrypted and the app role can't read MFA records", async () => {
    const [row] = await sysQuery<{ secret_enc: string; recovery_hashes: string[] }>("select secret_enc, recovery_hashes from user_mfa where user_id = $1", [w.staffId]);
    expect(row.secret_enc).not.toContain(secret);
    expect(row.recovery_hashes.join()).not.toContain(recovery[1].replace("-", ""));
    await expect(
      withSysTx(async (tx) => {
        await tx.q("set local role clientflow_app");
        return tx.q("select 1 from user_mfa");
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("password reset", () => {
  it("doesn't reveal whether an account exists", async () => {
    await expect(requestPasswordReset("nobody-here@test.example.com", "1.2.3.4")).resolves.toBeUndefined();
  });

  it("emails a single-use link and keeps the link out of the stored email", async () => {
    await requestPasswordReset(email.toUpperCase(), "1.2.3.4");
    const rows = await sysQuery<{ used_at: Date | null }>("select used_at from password_resets where user_id = $1", [w.staffId]);
    expect(rows).toHaveLength(1);
    const [mail] = await sysQuery<{ body: string; status: string; workspace_id: string | null }>(
      "select body, status, workspace_id from email_messages where kind = 'security' and to_email = $1",
      [email],
    );
    expect(mail.body).toContain("[link withheld from the log]");
    expect(mail.body).not.toMatch(/\/reset\/[A-Za-z0-9_-]{20,}/);
    // Demo-only account: simulated, never sent; and not shown in any workspace outbox.
    expect(mail.status).toBe("simulated");
    expect(mail.workspace_id).toBeNull();
    // Asking again cancels the earlier link.
    await requestPasswordReset(email, "1.2.3.4");
    const live = await sysQuery("select 1 from password_resets where user_id = $1 and used_at is null", [w.staffId]);
    expect(live).toHaveLength(1);
  });

  it("sets the new password, signs out every session, and can't be reused", async () => {
    const token = randomToken();
    await sysQuery("insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')", [w.staffId, sha256(token)]);
    const { token: session } = await createSession(w.staffId, w.workspaceId);
    expect(await lookupReset(token)).toEqual({ ok: true, email });
    expect((await completePasswordReset(token, "short")).ok).toBe(false);
    expect((await completePasswordReset(token, "brand-new-password-2")).ok).toBe(true);
    expect(await verifyCredentials(email, "brand-new-password-2")).toBe(w.staffId);
    expect(await verifyCredentials(email, "original-password-1")).toBeNull();
    expect(await resolveSession(session)).toBeNull();
    expect((await completePasswordReset(token, "another-password-3")).ok).toBe(false);
    expect(await lookupReset(token)).toEqual({ ok: false, reason: "used" });
    // Two-step sign-in stays on after a reset.
    const [mfa] = await sysQuery("select 1 from user_mfa where user_id = $1 and enabled_at is not null", [w.staffId]);
    expect(mfa).toBeTruthy();
  });

  it("expired links are refused", async () => {
    const token = randomToken();
    await sysQuery("insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, now() - interval '1 minute')", [w.staffId, sha256(token)]);
    expect(await lookupReset(token)).toEqual({ ok: false, reason: "expired" });
    expect((await completePasswordReset(token, "brand-new-password-4")).ok).toBe(false);
  });
});

describe("scanning policy", () => {
  it("refuses unscanned uploads when the workspace requires scanning", async () => {
    const item = (await itemByKey(w.clientA.onboardingId, "brand_guidelines")).id;
    await sysQuery("update workspaces set block_unscanned_uploads = true where id = $1", [w.workspaceId]);
    const res = await uploadDocument(w.ctx.clientA, { itemId: item, filename: "brand.pdf", data: PDF });
    expect(res.ok).toBe(false);
    const [{ n }] = await sysQuery<{ n: number }>("select count(*)::int as n from document_versions v join documents d on d.id = v.document_id where d.item_id = $1", [item]);
    expect(n).toBe(0);
    await sysQuery("update workspaces set block_unscanned_uploads = false where id = $1", [w.workspaceId]);
    expect((await uploadDocument(w.ctx.clientA, { itemId: item, filename: "brand.pdf", data: PDF })).ok).toBe(true);
  });
});
