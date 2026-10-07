import type { Tx } from "./db";
import { sendEmail } from "./email";
import { env } from "./env";

export type Recipient =
  | "onboarding_owner"
  | "account_manager"
  | "managers"
  | "reviewer"
  | "all_staff"
  | { userId: string };

export const RECIPIENT_LABEL: Record<Exclude<Recipient, { userId: string }>, string> = {
  onboarding_owner: "Onboarding owner",
  account_manager: "Account manager",
  managers: "Operations managers",
  reviewer: "Assigned reviewer",
  all_staff: "Whole team",
};

/** Resolves a recipient reference to staff user ids within the current workspace. */
export async function resolveRecipients(
  tx: Tx,
  ref: Recipient,
  context: { onboardingId?: string | null; clientId?: string | null; itemId?: string | null },
): Promise<string[]> {
  if (typeof ref === "object") {
    const m = await tx.one<{ user_id: string }>("select user_id from memberships where user_id = $1 and role <> 'client'", [ref.userId]);
    return m ? [m.user_id] : [];
  }
  switch (ref) {
    case "onboarding_owner": {
      if (!context.onboardingId) return [];
      const r = await tx.one<{ owner_user_id: string | null }>("select owner_user_id from onboardings where id = $1", [context.onboardingId]);
      return r?.owner_user_id ? [r.owner_user_id] : resolveRecipients(tx, "account_manager", context);
    }
    case "account_manager": {
      const r = await tx.one<{ owner_user_id: string | null }>(
        `select c.owner_user_id from clients c where c.id = coalesce($1::uuid, (select client_id from onboardings where id = $2::uuid))`,
        [context.clientId ?? null, context.onboardingId ?? null],
      );
      return r?.owner_user_id ? [r.owner_user_id] : [];
    }
    case "reviewer": {
      if (!context.itemId) return [];
      const r = await tx.one<{ id: string | null }>(
        "select coalesce(reviewer_user_id, owner_user_id) as id from onboarding_items where id = $1",
        [context.itemId],
      );
      return r?.id ? [r.id] : resolveRecipients(tx, "onboarding_owner", context);
    }
    case "managers": {
      const rows = await tx.q<{ user_id: string }>("select user_id from memberships where role = 'manager'");
      if (rows.length) return rows.map((r) => r.user_id);
      return (await tx.q<{ user_id: string }>("select user_id from memberships where role = 'admin'")).map((r) => r.user_id);
    }
    case "all_staff":
      return (await tx.q<{ user_id: string }>("select user_id from memberships where role in ('admin', 'manager', 'staff')")).map((r) => r.user_id);
  }
}

export interface NotificationInput {
  workspace: { id: string; name: string; is_demo: boolean; email_from_name: string | null };
  userIds: string[];
  title: string;
  body?: string | null;
  link?: string | null;
  onboardingId?: string | null;
  kind?: string;
  /** Prevents the same notification being created twice for the same user. */
  dedupeKey?: string | null;
  /** Also send an email copy (recorded only, never sent, in demo workspaces). */
  email?: boolean;
}

/** In-app notifications for staff, with an optional email copy. Returns how many were created. */
export async function notify(tx: Tx, input: NotificationInput) {
  let created = 0;
  for (const userId of [...new Set(input.userIds)]) {
    const row = await tx.one<{ created: boolean }>("select app.create_notification($1, $2, $3, $4, $5, $6, $7) as created", [
      userId,
      input.kind ?? "info",
      input.title.slice(0, 300),
      input.body?.slice(0, 2000) ?? null,
      input.link ?? null,
      input.onboardingId ?? null,
      input.dedupeKey ? `${input.dedupeKey}:${userId}` : null,
    ]);
    if (!row?.created) continue;
    created++;
    if (input.email) {
      const user = await tx.one<{ email: string }>("select email from users where id = $1", [userId]);
      if (user)
        await sendEmail(tx, input.workspace, {
          workspaceId: input.workspace.id,
          kind: "notification",
          to: user.email,
          subject: input.title.slice(0, 200),
          body: `${input.body ?? input.title}${input.link ? `\n\nOpen in ClientFlow: ${env.appUrl}${input.link}` : ""}`,
          onboardingId: input.onboardingId ?? null,
          dedupeKey: input.dedupeKey ? `notify:${input.dedupeKey}:${userId}` : null,
        });
    }
  }
  return created;
}
