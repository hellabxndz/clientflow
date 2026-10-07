import bcrypt from "bcryptjs";
import { sysQuery, withSysTx, type TenantContext } from "./db";
import { randomToken, sha256 } from "./tokens";
import { rateLimit } from "./rate-limit";

export const SESSION_COOKIE = "cf_session";
export const SESSION_TTL_DAYS = 14;
export const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS ?? 168);

export type Role = "admin" | "manager" | "staff" | "client";

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; name: string; mfa_enabled: boolean };
  workspace: {
    id: string;
    name: string;
    slug: string;
    is_demo: boolean;
    brand_color: string;
    logo_url: string | null;
    portal_welcome: string;
    timezone: string;
    template_edit_role: "admin" | "staff";
    ai_enabled: boolean;
    ai_process_documents: boolean;
    retention_days: number | null;
    max_upload_mb: number;
    email_from_name: string | null;
    accent_color: string;
    portal_name: string | null;
    support_email: string | null;
    support_phone: string | null;
    logo_storage_key: string | null;
    business_days: number[];
    business_start_hour: number;
    business_end_hour: number;
    kickoff_lead_days: number;
    launched_at: Date | null;
    require_staff_mfa: boolean;
    block_unscanned_uploads: boolean;
  };
  role: Role;
  clientId: string | null;
  canApprove: boolean;
  workspaces: { id: string; name: string; role: Role; is_demo: boolean }[];
}

export function tenantCtx(auth: AuthContext): TenantContext {
  return { workspaceId: auth.workspace.id, userId: auth.user.id, role: auth.role, clientId: auth.clientId };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 11);
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

// ---------------------------------------------------------------------------
// Login + sessions
// ---------------------------------------------------------------------------

/** Login/invitation throttle shared across instances (Postgres `rate_limits`). Resolves false when the limit is exceeded. */
export async function throttle(key: string, limit = 8, windowMs = 15 * 60 * 1000) {
  return (await rateLimit(key, limit, windowMs)).ok;
}

let dummyHash: string | undefined;

export async function verifyCredentials(email: string, password: string) {
  const [user] = await sysQuery<{ id: string; password_hash: string | null }>(
    "select id, password_hash from users where email = $1",
    [email.trim()],
  );
  // Compare against a dummy hash when the user is missing to keep timing similar.
  dummyHash ??= bcrypt.hashSync("timing-equalizer", 11);
  const hash = user?.password_hash ?? dummyHash;
  const ok = await bcrypt.compare(password, hash);
  if (!user || !user.password_hash || !ok) return null;
  return user.id;
}

export async function createSession(userId: string, workspaceId: string | null, userAgent?: string | null) {
  const token = randomToken(32);
  const [row] = await sysQuery<{ id: string }>(
    `insert into sessions (token_hash, user_id, workspace_id, user_agent, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' days')::interval) returning id`,
    [sha256(token), userId, workspaceId, userAgent?.slice(0, 300) ?? null, String(SESSION_TTL_DAYS)],
  );
  await sysQuery("update users set last_login_at = now() where id = $1", [userId]);
  return { token, sessionId: row.id };
}

export async function resolveSession(token: string | undefined | null): Promise<AuthContext | null> {
  if (!token) return null;
  const [session] = await sysQuery<{ id: string; user_id: string; workspace_id: string | null; last_seen_at: Date }>(
    `select id, user_id, workspace_id, last_seen_at from sessions
     where token_hash = $1 and revoked_at is null and expires_at > now()`,
    [sha256(token)],
  );
  if (!session) return null;

  const memberships = await sysQuery<{
    workspace_id: string;
    role: Role;
    client_id: string | null;
    can_approve: boolean;
    name: string;
    is_demo: boolean;
  }>(
    `select m.workspace_id, m.role, m.client_id, m.can_approve, w.name, w.is_demo
     from memberships m join workspaces w on w.id = m.workspace_id
     where m.user_id = $1 order by w.is_demo, w.created_at`,
    [session.user_id],
  );
  if (memberships.length === 0) return null;
  const active = memberships.find((m) => m.workspace_id === session.workspace_id) ?? memberships[0];

  const [[user], [workspace]] = await Promise.all([
    sysQuery<AuthContext["user"]>(
      "select id, email, name, exists (select 1 from user_mfa f where f.user_id = users.id and f.enabled_at is not null) as mfa_enabled from users where id = $1",
      [session.user_id],
    ),
    sysQuery<AuthContext["workspace"]>(
      `select id, name, slug, is_demo, brand_color, logo_url, portal_welcome, timezone, template_edit_role,
              ai_enabled, ai_process_documents, retention_days, max_upload_mb, email_from_name, accent_color, portal_name,
              support_email, support_phone, logo_storage_key, business_days, business_start_hour, business_end_hour,
              kickoff_lead_days, launched_at, require_staff_mfa, block_unscanned_uploads
       from workspaces where id = $1`,
      [active.workspace_id],
    ),
  ]);
  if (!user || !workspace) return null;

  if (Date.now() - new Date(session.last_seen_at).getTime() > 5 * 60 * 1000) {
    await sysQuery("update sessions set last_seen_at = now() where id = $1", [session.id]);
  }

  return {
    sessionId: session.id,
    user,
    workspace,
    role: active.role,
    clientId: active.client_id,
    canApprove: active.role === "admin" || active.role === "manager" || active.can_approve,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.name, role: m.role, is_demo: m.is_demo })),
  };
}

export async function switchWorkspace(sessionId: string, userId: string, workspaceId: string) {
  const [m] = await sysQuery("select 1 from memberships where user_id = $1 and workspace_id = $2", [
    userId,
    workspaceId,
  ]);
  if (!m) throw new Error("Not a member of that workspace");
  await sysQuery("update sessions set workspace_id = $1 where id = $2", [workspaceId, sessionId]);
}

export async function revokeSession(sessionId: string, userId: string) {
  await sysQuery("update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [
    sessionId,
    userId,
  ]);
}

export async function revokeAllSessionsForUser(userId: string, exceptSessionId?: string) {
  await sysQuery(
    "update sessions set revoked_at = now() where user_id = $1 and revoked_at is null and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')",
    [userId, exceptSessionId ?? null],
  );
}

export async function listSessions(userId: string) {
  return sysQuery<{ id: string; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
    `select id, user_agent, created_at, last_seen_at, expires_at from sessions
     where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InvitationInfo {
  id: string;
  workspace_id: string;
  workspace_name: string;
  brand_color: string;
  email: string;
  role: Role;
  client_id: string | null;
  client_name: string | null;
  expires_at: Date;
  user_exists: boolean;
}

export type InvitationState = { ok: true; invitation: InvitationInfo } | { ok: false; reason: "invalid" | "expired" | "used" | "revoked" };

export async function lookupInvitation(token: string): Promise<InvitationState> {
  const [row] = await sysQuery<
    InvitationInfo & { accepted_at: Date | null; revoked_at: Date | null; expired: boolean }
  >(
    `select i.id, i.workspace_id, w.name as workspace_name, w.brand_color, i.email, i.role, i.client_id,
            c.name as client_name, i.expires_at, i.accepted_at, i.revoked_at, i.expires_at <= now() as expired,
            exists (select 1 from users u where u.email = i.email and u.password_hash is not null) as user_exists
     from invitations i join workspaces w on w.id = i.workspace_id left join clients c on c.id = i.client_id
     where i.token_hash = $1`,
    [sha256(token)],
  );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.accepted_at) return { ok: false, reason: "used" };
  if (row.expired) return { ok: false, reason: "expired" };
  return { ok: true, invitation: row };
}

export async function acceptInvitation(
  token: string,
  input: { name: string; password: string },
): Promise<{ ok: true; userId: string; workspaceId: string } | { ok: false; error: string }> {
  return withSysTx(async (tx) => {
    const inv = await tx.one<{
      id: string;
      workspace_id: string;
      email: string;
      role: Role;
      client_id: string | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>("select * from invitations where token_hash = $1 for update", [sha256(token)]);
    if (!inv) return { ok: false, error: "This invitation link is not valid." };
    if (inv.revoked_at) return { ok: false, error: "This invitation was revoked." };
    if (inv.accepted_at) return { ok: false, error: "This invitation has already been used." };
    if (new Date(inv.expires_at).getTime() <= Date.now()) return { ok: false, error: "This invitation has expired." };

    let user = await tx.one<{ id: string; password_hash: string | null }>(
      "select id, password_hash from users where email = $1 for update",
      [inv.email],
    );
    if (user?.password_hash) {
      const ok = await bcrypt.compare(input.password, user.password_hash);
      if (!ok) return { ok: false, error: "An account with this email exists. Enter its current password to join." };
    } else {
      const problem = validatePassword(input.password);
      if (problem) return { ok: false, error: problem };
      const name = input.name.trim();
      if (!name) return { ok: false, error: "Please enter your name." };
      const hash = await hashPassword(input.password);
      user = await tx.one<{ id: string; password_hash: string | null }>(
        `insert into users (email, name, password_hash) values ($1, $2, $3)
         on conflict (email) do update set name = excluded.name, password_hash = excluded.password_hash
         returning id, password_hash`,
        [inv.email, name, hash],
      );
    }
    const existing = await tx.one("select 1 from memberships where workspace_id = $1 and user_id = $2", [
      inv.workspace_id,
      user!.id,
    ]);
    if (existing) return { ok: false, error: "You already belong to this workspace. Sign in instead." };
    await tx.q(
      `insert into memberships (workspace_id, user_id, role, client_id) values ($1, $2, $3, $4)`,
      [inv.workspace_id, user!.id, inv.role, inv.client_id],
    );
    await tx.q("update invitations set accepted_at = now() where id = $1", [inv.id]);
    await tx.q(
      `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary)
       values ($1, $2, 'invitation.accepted', 'invitation', $3, $4)`,
      [inv.workspace_id, user!.id, inv.id, `${inv.email} accepted an invitation as ${inv.role}`],
    );
    return { ok: true, userId: user!.id, workspaceId: inv.workspace_id };
  });
}
