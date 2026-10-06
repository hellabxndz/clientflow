import { sysQuery, withTenant } from "./db";
import { getStorage } from "./storage";
import { audit } from "./audit";

/**
 * Deletes stored file contents for onboardings that finished (completed or cancelled) more
 * than `retention_days` ago. Metadata (name, size, hash, review history) is kept for the audit
 * trail; the bytes are removed and download links stop working.
 */
export async function runRetention(opts: { workspaceId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const workspaces = await sysQuery<{ id: string; retention_days: number }>(
    "select id, retention_days from workspaces where retention_days is not null and ($1::uuid is null or id = $1)",
    [opts.workspaceId ?? null],
  );
  let purged = 0;
  for (const ws of workspaces) {
    await withTenant({ workspaceId: ws.id, userId: null, role: "system" }, async (tx) => {
      const rows = await tx.q<{ id: string; storage_key: string; original_name: string }>(
        `select v.id, v.storage_key, v.original_name from document_versions v
         join documents d on d.id = v.document_id join onboardings o on o.id = d.onboarding_id
         where v.purged_at is null and v.storage_key is not null
           and o.status in ('completed', 'cancelled')
           and coalesce(o.completed_at, o.paused_at, o.created_at) < $1::timestamptz - ($2 || ' days')::interval`,
        [now.toISOString(), String(ws.retention_days)],
      );
      for (const row of rows) {
        await getStorage().delete(row.storage_key);
        await tx.q("update document_versions set purged_at = now(), storage_key = null where id = $1", [row.id]);
        purged++;
      }
      if (rows.length)
        await audit(tx, { workspaceId: ws.id, userId: null, role: "system" }, "retention.purged", null, null,
          `Retention policy removed ${rows.length} stored file${rows.length === 1 ? "" : "s"} older than ${ws.retention_days} days`);
    });
  }
  return { purged };
}
