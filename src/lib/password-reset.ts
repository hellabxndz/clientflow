import { sysQuery, withSysTx, type Tx } from "./db";
import { env } from "./env";
import { randomToken, sha256 } from "./tokens";
import { hashPassword, validatePassword } from "./auth";
import { deliverRecorded } from "./email";

export const RESET_TTL_MINUTES = 60;

/** Records an account-security event in every workspace the user belongs to, so each admin can see it. */
export async function auditAccount(tx: Tx, userId: string, actorId: string | null, action: string, summary: string) {
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, metadata, category)
     select m.workspace_id, $2, $3, 'user', $1, $4, '{}'::jsonb, split_part($3, '.', 1) from memberships m where m.user_id = $1`,
    [userId, actorId, action, summary],
  );
}

/**
 * Creates a single-use reset link and emails it. Always resolves the same way whether or not the
 * account exists, so the form can't be used to discover accounts.
 *
 * The link is never stored: the database keeps only its hash, and the recorded email body has the link
 * withheld so admins reading the outbox can't use it. Accounts that only belong to demo workspaces get a
 * simulated email; outside production the link is printed to the server console for local testing.
 */
export async function requestPasswordReset(email: string, ip: string | null) {
  const normalized = email.trim().toLowerCase();
  const [user] = await sysQuery<{ id: string; name: string; email: string; live: boolean }>(
    `select u.id, u.name, u.email, bool_or(not w.is_demo) as live
     from users u join memberships m on m.user_id = u.id join workspaces w on w.id = m.workspace_id
     where lower(u.email) = $1 and u.password_hash is not null group by u.id`,
    [normalized],
  );
  if (!user) return;

  const token = randomToken(32);
  const link = `${env.appUrl}/reset/${token}`;
  await withSysTx(async (tx) => {
    // One live link at a time: requesting a new one cancels the previous ones.
    await tx.q("update password_resets set used_at = now() where user_id = $1 and used_at is null", [user.id]);
    await tx.q(
      `insert into password_resets (user_id, token_hash, expires_at, requested_ip) values ($1, $2, now() + ($3 || ' minutes')::interval, $4)`,
      [user.id, sha256(token), String(RESET_TTL_MINUTES), ip],
    );
    const subject = "Reset your ClientFlow password";
    const body = (url: string) =>
      `Hi ${user.name},\n\nSomeone asked to reset the password for ${user.email}. If it was you, open this link within ${RESET_TTL_MINUTES} minutes:\n\n${url}\n\nIf you didn't ask, ignore this email; your password stays the same.`;
    const row = await tx.one<{ id: string }>(
      `insert into email_messages (workspace_id, kind, to_email, subject, body, status) values (null, 'security', $1, $2, $3, 'queued') returning id`,
      [user.email, subject, body("[link withheld from the log]")],
    );
    await deliverRecorded(tx, { is_demo: !user.live }, { id: row!.id, to: user.email, subject, body: body(link) });
    await auditAccount(tx, user.id, null, "auth.password_reset_requested", `Password reset requested for ${user.email}`);
  });
  if (!env.isProduction) console.info(`[dev] password reset link for ${user.email}: ${link}`);
}

export type ResetLookup = { ok: true; email: string } | { ok: false; reason: "invalid" | "expired" | "used" };

export async function lookupReset(token: string): Promise<ResetLookup> {
  const [row] = await sysQuery<{ email: string; expires_at: Date; used_at: Date | null }>(
    "select u.email, r.expires_at, r.used_at from password_resets r join users u on u.id = r.user_id where r.token_hash = $1",
    [sha256(token)],
  );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: "expired" };
  return { ok: true, email: row.email };
}

/** Sets the new password, uses up the link, and signs the account out everywhere. Two-step sign-in stays on. */
export async function completePasswordReset(token: string, password: string): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const problem = validatePassword(password);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(password);
  return withSysTx(async (tx) => {
    const row = await tx.one<{ id: string; user_id: string }>(
      "select id, user_id from password_resets where token_hash = $1 and used_at is null and expires_at > now() for update",
      [sha256(token)],
    );
    if (!row) return { ok: false as const, error: "This reset link has expired or was already used. Request a new one." };
    await tx.q("update password_resets set used_at = now() where user_id = $1 and used_at is null", [row.user_id]);
    await tx.q("update users set password_hash = $2 where id = $1", [row.user_id, hash]);
    await tx.q("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [row.user_id]);
    await auditAccount(tx, row.user_id, row.user_id, "auth.password_reset", "Password was reset with an emailed link; all sessions were signed out");
    return { ok: true as const, userId: row.user_id };
  });
}
