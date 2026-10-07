"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { afterWrite, fail, str } from "@/lib/action-helpers";
import { parseCsv } from "@/lib/csv";
import { executeImport, guessMapping, IMPORT_FIELDS, IMPORT_KINDS, IMPORT_LABEL, type ImportKind } from "@/lib/import";
import type { ActionState } from "@/components/forms";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;

export async function uploadImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string;
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const kind = str(fd, "kind") as ImportKind;
    if (!IMPORT_KINDS.includes(kind)) return { error: "Choose what you're importing." };
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
    if (!/\.(csv|txt)$/i.test(file.name)) return { error: "Upload a .csv file (export it from your spreadsheet as CSV)." };
    if (file.size > MAX_BYTES) return { error: "The file is larger than 2 MB. Split it into smaller files." };
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.includes(0)) return { error: "That doesn't look like a text CSV file." };
    const { header, rows } = parseCsv(buf.toString("utf8"), { maxRows: MAX_ROWS });
    if (rows.length === 0) return { error: "The file has a header row but no data rows." };
    if (rows.length > MAX_ROWS) return { error: `The file has more than ${MAX_ROWS} rows. Split it into smaller files.` };
    if (header.length > 60) return { error: "The file has more than 60 columns." };
    const mapping = guessMapping(kind, header);
    const filename = file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
    id = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `insert into imports (workspace_id, kind, filename, header, rows, mapping, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [auth.workspace.id, kind, filename, header, JSON.stringify(rows), JSON.stringify(mapping), auth.user.id],
      );
      await audit(tx, ctx, "import.uploaded", null, null, `Uploaded ${filename} (${rows.length} ${IMPORT_LABEL[kind].toLowerCase()} rows) for import`, { importId: row!.id });
      return row!.id;
    });
  } catch (e) {
    return fail(e);
  }
  redirect(`/app/settings/import?id=${id}`);
}

export async function saveMappingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const id = str(fd, "id");
    await withTenant(ctx, async (tx) => {
      const imp = await tx.one<{ kind: ImportKind; header: string[]; status: string }>("select kind, header, status from imports where id = $1", [id]);
      if (!imp) throw new Error("Import not found.");
      if (imp.status !== "uploaded") throw new Error("This import has already run.");
      const mapping: Record<string, number> = {};
      const used = new Set<number>();
      for (const f of IMPORT_FIELDS[imp.kind]) {
        const v = str(fd, `map_${f.key}`);
        if (v === "") continue;
        const idx = Number(v);
        if (!Number.isInteger(idx) || idx < 0 || idx >= imp.header.length) throw new Error(`Invalid column for ${f.label}.`);
        if (used.has(idx)) throw new Error(`Column "${imp.header[idx]}" is mapped to more than one field.`);
        used.add(idx);
        mapping[f.key] = idx;
      }
      await tx.q("update imports set mapping = $2 where id = $1", [id, JSON.stringify(mapping)]);
    });
    revalidatePath("/app/settings/import");
    return { ok: "Mapping saved. The preview below is updated." };
  } catch (e) {
    return fail(e);
  }
}

export async function runImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const id = str(fd, "id");
    const summary = await withTenant(ctx, async (tx) => {
      const imp = await tx.one<{ kind: ImportKind; rows: string[][]; mapping: Record<string, number>; status: string }>(
        "select kind, rows, mapping, status from imports where id = $1 for update",
        [id],
      );
      if (!imp) throw new Error("Import not found.");
      if (imp.status !== "uploaded") throw new Error("This import has already run.");
      const s = await executeImport(tx, ctx, imp.kind, imp.rows, imp.mapping);
      await tx.q("update imports set status = 'completed', summary = $2, completed_at = now() where id = $1", [id, JSON.stringify(s)]);
      return s;
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/app", "layout");
    return { ok: `Imported ${summary.created}. ${summary.skippedDuplicates} duplicate${summary.skippedDuplicates === 1 ? "" : "s"} skipped, ${summary.failed} failed.` };
  } catch (e) {
    return fail(e);
  }
}

export async function discardImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ filename: string }>("delete from imports where id = $1 and status = 'uploaded' returning filename", [str(fd, "id")]);
      if (!row) throw new Error("Only imports that haven't run can be discarded.");
      await audit(tx, ctx, "import.discarded", null, null, `Discarded uploaded file ${row.filename} without importing`);
    });
  } catch (e) {
    return fail(e);
  }
  redirect("/app/settings/import");
}
