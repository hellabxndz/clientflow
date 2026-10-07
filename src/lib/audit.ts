import type { TenantContext, Tx } from "./db";

/**
 * Appends to the audit log. The client and onboarding are resolved from the entity so every
 * event also shows up on that client's timeline.
 */
export async function audit(
  tx: Tx,
  ctx: TenantContext,
  action: string,
  entityType: string | null,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {},
  refs: { clientId?: string | null; onboardingId?: string | null } = {},
) {
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, metadata, client_id, onboarding_id, category)
     values ($1, $2, $3, $4, $5::uuid, $6, $7,
       coalesce($8::uuid, case $4::text
         when 'client' then $5::uuid
         when 'onboarding' then (select client_id from onboardings where id = $5::uuid)
         when 'item' then (select client_id from onboarding_items where id = $5::uuid)
         when 'document' then (select client_id from documents where id = $5::uuid)
         when 'document_version' then (select client_id from document_versions where id = $5::uuid)
       end),
       coalesce($9::uuid, case $4::text
         when 'onboarding' then $5::uuid
         when 'item' then (select onboarding_id from onboarding_items where id = $5::uuid)
         when 'document' then (select onboarding_id from documents where id = $5::uuid)
         when 'document_version' then (select d.onboarding_id from document_versions v join documents d on d.id = v.document_id where v.id = $5::uuid)
       end),
       split_part($3, '.', 1))`,
    [
      ctx.workspaceId,
      ctx.userId,
      action,
      entityType,
      entityId,
      summary.slice(0, 500),
      JSON.stringify(metadata),
      refs.clientId ?? null,
      refs.onboardingId ?? null,
    ],
  );
}
