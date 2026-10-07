import type { TenantContext, Tx } from "./db";
import { INVITE_TTL_HOURS } from "./auth";
import { randomToken, sha256 } from "./tokens";
import { env } from "./env";
import { sendEmail } from "./email";
import { audit } from "./audit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates an expiring, single-use invitation. Only a hash of the token is stored. RLS allows
 * staff to invite clients and only admins to invite staff or admins.
 */
export async function createInvitation(
  tx: Tx,
  ctx: TenantContext,
  input: { email: string; role: "admin" | "manager" | "staff" | "client"; clientId?: string | null; ttlHours?: number },
) {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");
  if (input.role !== "client" && ctx.role !== "admin" && ctx.role !== "system") throw new Error("Only admins can invite team members.");
  const already = await tx.one(
    `select 1 from memberships m join users u on u.id = m.user_id where u.email = $1`,
    [email],
  );
  if (already) throw new Error("That person is already a member of this workspace.");
  // Revoke earlier pending invitations for the same email so only the newest link works.
  await tx.q(
    "update invitations set revoked_at = now() where email = $1 and accepted_at is null and revoked_at is null",
    [email],
  );
  const token = randomToken(32);
  const ttl = input.ttlHours ?? INVITE_TTL_HOURS;
  const row = await tx.one<{ id: string; expires_at: Date }>(
    `insert into invitations (workspace_id, email, role, client_id, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval) returning id, expires_at`,
    [ctx.workspaceId, email, input.role, input.role === "client" ? input.clientId : null, sha256(token), ctx.userId, String(ttl)],
  );
  const url = `${env.appUrl}/invite/${token}`;
  await audit(tx, ctx, "invitation.created", "invitation", row!.id, `Invited ${email} as ${input.role}`);
  return { id: row!.id, token, url, expiresAt: row!.expires_at };
}

export async function sendInvitationEmail(
  tx: Tx,
  workspace: { id: string; name: string; is_demo: boolean; email_from_name: string | null },
  invite: { url: string; expiresAt: Date },
  to: string,
  role: string,
  clientName?: string | null,
) {
  const subject =
    role === "client" ? `${workspace.name}: your onboarding portal is ready` : `You're invited to join ${workspace.name} on ClientFlow`;
  const body =
    role === "client"
      ? `Hello,\n\n${workspace.name} has set up a secure portal for ${clientName ?? "your company"}'s onboarding. You'll see exactly what's needed, can save your progress, and upload files privately.\n\nSet up your access: ${invite.url}\n\nThis link expires on ${new Date(invite.expiresAt).toUTCString()} and can be used once.\n\nPlease never send passwords through the portal. We'll always ask for delegated access instead.`
      : `Hello,\n\nYou've been invited to join ${workspace.name} on ClientFlow.\n\nAccept the invitation: ${invite.url}\n\nThis link expires on ${new Date(invite.expiresAt).toUTCString()} and can be used once.`;
  return sendEmail(tx, workspace, { workspaceId: workspace.id, kind: "invitation", to, subject, body });
}
