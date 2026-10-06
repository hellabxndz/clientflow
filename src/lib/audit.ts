import type { TenantContext, Tx } from "./db";

export async function audit(
  tx: Tx,
  ctx: TenantContext,
  action: string,
  entityType: string | null,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.q(
    `insert into audit_events (workspace_id, actor_user_id, action, entity_type, entity_id, summary, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.workspaceId, ctx.userId, action, entityType, entityId, summary.slice(0, 500), JSON.stringify(metadata)],
  );
}
