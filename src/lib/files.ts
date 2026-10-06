import crypto from "node:crypto";
import { withTenant, type TenantContext } from "./db";
import { getScanner } from "./scanning";
import { getStorage } from "./storage";
import { sha256, signPayload, verifyPayload } from "./tokens";
import { audit } from "./audit";

export const DOWNLOAD_LINK_TTL_SECONDS = 300;

const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "msi", "scr", "js", "mjs", "vbs", "ps1", "sh", "jar", "html", "htm", "svgz", "php", "dll",
]);

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  eps: "application/postscript",
  ai: "application/postscript",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  key: "application/octet-stream",
  zip: "application/zip",
};

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  pptx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  svg: (b) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8")) && !/<script/i.test(b.toString("utf8")),
};

export function extensionOf(filename: string) {
  const m = /\.([a-zA-Z0-9]{1,10})$/.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

export interface FileRules {
  accept: string[];
  maxSizeMb: number;
  maxFiles?: number;
}

export function checkFileAgainstRules(
  file: { name: string; size: number; data: Buffer },
  rules: FileRules,
  workspaceMaxMb: number,
): string | null {
  const ext = extensionOf(file.name);
  if (!ext) return "The file needs an extension (for example .pdf).";
  if (BLOCKED_EXTENSIONS.has(ext)) return `.${ext} files are not allowed.`;
  if (!rules.accept.map((a) => a.toLowerCase()).includes(ext))
    return `.${ext} files are not accepted here. Allowed: ${rules.accept.map((a) => "." + a).join(", ")}.`;
  const limitMb = Math.min(rules.maxSizeMb, workspaceMaxMb);
  if (file.size > limitMb * 1024 * 1024) return `File is larger than the ${limitMb} MB limit.`;
  if (file.size === 0) return "The file is empty.";
  const magic = MAGIC[ext];
  if (magic && !magic(file.data)) return `The file content does not look like a valid .${ext} file.`;
  return null;
}

function safeName(name: string) {
  return name.replace(/[^\w.\- ()]/g, "_").slice(0, 180) || "file";
}

export type UploadResult = { ok: true; versionId: string; scanStatus: string } | { ok: false; error: string };

export async function uploadDocument(
  ctx: TenantContext,
  input: { itemId: string; documentId?: string | null; filename: string; data: Buffer },
): Promise<UploadResult> {
  const scanner = getScanner();
  const storage = getStorage();

  // Validate against item rules first (RLS hides items the user can't see).
  const pre = await withTenant(ctx, async (tx) => {
    const item = await tx.one<{
      id: string;
      kind: string;
      status: string;
      config: { file?: FileRules };
      client_id: string;
      onboarding_id: string;
      onboarding_status: string;
      max_upload_mb: number;
    }>(
      `select i.id, i.kind, i.status, i.config, i.client_id, i.onboarding_id, o.status as onboarding_status, w.max_upload_mb
       from onboarding_items i join onboardings o on o.id = i.onboarding_id join workspaces w on w.id = i.workspace_id
       where i.id = $1`,
      [input.itemId],
    );
    if (!item) return { error: "Request not found." } as const;
    if (item.kind !== "file" || !item.config.file) return { error: "This request does not accept files." } as const;
    if (item.status === "approved") return { error: "This request is already approved." } as const;
    if (item.onboarding_status !== "active") return { error: "This onboarding is not active." } as const;
    if (!input.documentId) {
      const [{ count }] = await tx.q<{ count: string }>("select count(*) from documents where item_id = $1", [item.id]);
      if (item.config.file.maxFiles && Number(count) >= item.config.file.maxFiles)
        return { error: `This request accepts up to ${item.config.file.maxFiles} files. Upload a new version of an existing file instead.` } as const;
    } else {
      const doc = await tx.one("select id from documents where id = $1 and item_id = $2", [input.documentId, item.id]);
      if (!doc) return { error: "Document not found." } as const;
    }
    return { item } as const;
  });
  if ("error" in pre) return { ok: false, error: pre.error! };

  const problem = checkFileAgainstRules(
    { name: input.filename, size: input.data.length, data: input.data },
    pre.item.config.file!,
    pre.item.max_upload_mb,
  );
  if (problem) return { ok: false, error: problem };

  const scan = await scanner.scan(input.data);
  if (scan.status === "infected") {
    await withTenant(ctx, (tx) =>
      audit(tx, ctx, "document.rejected_malware", "item", input.itemId, `Upload "${safeName(input.filename)}" was rejected by the malware scanner`, {
        detail: scan.detail,
      }),
    );
    return { ok: false, error: "This file was flagged by the malware scanner and was not stored." };
  }

  const ext = extensionOf(input.filename);
  const storageKey = `${ctx.workspaceId}/${pre.item.client_id}/${crypto.randomUUID()}`;
  await storage.put(storageKey, input.data);

  try {
    return await withTenant(ctx, async (tx) => {
      let documentId = input.documentId ?? null;
      if (!documentId) {
        const doc = await tx.one<{ id: string }>(
          `insert into documents (workspace_id, client_id, onboarding_id, item_id, title) values ($1,$2,$3,$4,$5) returning id`,
          [ctx.workspaceId, pre.item.client_id, pre.item.onboarding_id, pre.item.id, safeName(input.filename)],
        );
        documentId = doc!.id;
      }
      const [{ next }] = await tx.q<{ next: number }>(
        "select coalesce(max(version), 0) + 1 as next from document_versions where document_id = $1",
        [documentId],
      );
      const version = await tx.one<{ id: string }>(
        `insert into document_versions (workspace_id, client_id, document_id, version, storage_key, original_name, mime_type,
           size_bytes, sha256, scan_status, scan_detail, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [
          ctx.workspaceId,
          pre.item.client_id,
          documentId,
          next,
          storageKey,
          safeName(input.filename),
          MIME_BY_EXT[ext] ?? "application/octet-stream",
          input.data.length,
          sha256(input.data),
          scan.status,
          scan.detail ?? null,
          ctx.userId,
        ],
      );
      if (ctx.role === "client") {
        await tx.q(
          `update onboarding_items set status = 'in_progress', updated_at = now()
           where id = $1 and status in ('not_started', 'changes_requested', 'submitted')`,
          [pre.item.id],
        );
      }
      await audit(tx, ctx, "document.uploaded", "document", documentId, `Uploaded "${safeName(input.filename)}" (v${next})`, {
        itemId: pre.item.id,
        scan: scan.status,
      });
      return { ok: true as const, versionId: version!.id, scanStatus: scan.status };
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => {});
    throw err;
  }
}

/** Issues a short-lived download link after checking (via RLS) that the caller can see the file. */
export async function createDownloadLink(ctx: TenantContext, versionId: string) {
  const row = await withTenant(ctx, (tx) =>
    tx.one<{ id: string; purged_at: Date | null }>("select id, purged_at from document_versions where id = $1", [versionId]),
  );
  if (!row || row.purged_at) return null;
  const token = signPayload({ v: versionId, u: ctx.userId, w: ctx.workspaceId }, DOWNLOAD_LINK_TTL_SECONDS);
  return `/api/files/download?t=${encodeURIComponent(token)}`;
}

/** Resolves a download token for the signed-in user. Returns null if expired, forged or not authorized. */
export async function resolveDownload(ctx: TenantContext, token: string) {
  const payload = verifyPayload<{ v: string; u: string; w: string }>(token);
  if (!payload || payload.u !== ctx.userId || payload.w !== ctx.workspaceId) return null;
  const row = await withTenant(ctx, (tx) =>
    tx.one<{ storage_key: string | null; original_name: string; mime_type: string; purged_at: Date | null }>(
      "select storage_key, original_name, mime_type, purged_at from document_versions where id = $1",
      [payload.v],
    ),
  );
  if (!row || !row.storage_key || row.purged_at) return null;
  const data = await getStorage().get(row.storage_key);
  await withTenant(ctx, (tx) =>
    audit(tx, ctx, "document.downloaded", "document_version", payload.v, `Downloaded "${row.original_name}"`),
  );
  return { data, filename: row.original_name, mime: row.mime_type };
}
