import { describe, it, expect } from "vitest";
import { withSysTx } from "../src/lib/db";
import { uploadDocument, createDownloadLink } from "../src/lib/files";
import { runRetention } from "../src/lib/retention";
import { makeWorkspace, itemByKey, PDF } from "./fixtures";

describe("file retention", () => {
  it("removes stored files only for onboardings finished longer ago than the retention period", async () => {
    const w = await makeWorkspace();
    const a = await itemByKey(w.clientA.onboardingId, "brand_guidelines");
    const b = await itemByKey(w.clientB.onboardingId, "brand_guidelines");
    const va = await uploadDocument(w.ctx.clientA, { itemId: a.id, filename: "a.pdf", data: PDF });
    const vb = await uploadDocument(w.ctx.clientB, { itemId: b.id, filename: "b.pdf", data: PDF });
    if (!va.ok || !vb.ok) throw new Error("upload failed");
    await withSysTx(async (tx) => {
      await tx.q("update workspaces set retention_days = 30 where id = $1", [w.workspaceId]);
      await tx.q("update onboardings set status = 'completed', completed_at = now() - interval '45 days' where id = $1", [w.clientA.onboardingId]);
      await tx.q("update onboardings set status = 'completed', completed_at = now() - interval '5 days' where id = $1", [w.clientB.onboardingId]);
    });
    const r = await runRetention({ workspaceId: w.workspaceId });
    expect(r.purged).toBe(1);
    expect(await createDownloadLink(w.ctx.staff, va.versionId)).toBeNull();
    expect(await createDownloadLink(w.ctx.staff, vb.versionId)).not.toBeNull();
    const meta = await withSysTx((tx) => tx.one<{ sha256: string; purged_at: Date }>("select sha256, purged_at from document_versions where id = $1", [va.versionId]));
    expect(meta!.purged_at).not.toBeNull();
    expect(meta!.sha256).toHaveLength(64);
  });

  it("does nothing when retention is not configured", async () => {
    const w = await makeWorkspace();
    await withSysTx((tx) => tx.q("update onboardings set status = 'completed', completed_at = now() - interval '400 days' where workspace_id = $1", [w.workspaceId]));
    expect((await runRetention({ workspaceId: w.workspaceId })).purged).toBe(0);
  });
});
