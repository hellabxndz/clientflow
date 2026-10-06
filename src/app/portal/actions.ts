"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { uploadDocument } from "@/lib/files";
import { unmetDependencies, type ItemLike } from "@/lib/onboarding";
import type { FormField } from "@/lib/templates";
import { validateField } from "@/lib/form-validation";
import type { ActionState } from "@/components/forms";


function fail(e: unknown): ActionState {
  const message = e instanceof Error ? e.message : "Something went wrong.";
  if (/row-level security|permission denied|clients may only|clients cannot/i.test(message)) return { error: "You don't have access to change that." };
  return { error: message };
}

export async function saveItemAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("client");
    const ctx = tenantCtx(auth);
    const itemId = String(fd.get("itemId") ?? "");
    const submitting = fd.get("intent") === "submit";
    const result = await withTenant(ctx, async (tx) => {
      const item = await tx.one<ItemLike & { onboarding_id: string; config: { fields?: FormField[]; checklist?: { key: string; label: string }[] }; response: Record<string, unknown>; onboarding_status: string }>(
        `select i.*, o.status as onboarding_status from onboarding_items i join onboardings o on o.id = i.onboarding_id where i.id = $1`,
        [itemId],
      );
      if (!item) throw new Error("This request isn't available.");
      if (item.status === "approved") throw new Error("This item is already approved.");
      if (item.onboarding_status === "completed" || item.onboarding_status === "cancelled") throw new Error("This onboarding is closed.");
      if (submitting) {
        const siblings = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
        if (unmetDependencies(item, new Map(siblings.map((s) => [s.item_key, s]))).length)
          throw new Error("This item opens once the earlier steps are approved.");
      }

      let response: Record<string, unknown> = {};
      const errors: string[] = [];
      if (item.kind === "form") {
        for (const f of item.config.fields ?? []) {
          const raw = f.type === "multiselect" ? fd.getAll(`f_${f.key}`) : fd.get(`f_${f.key}`);
          const r = validateField(f, raw, submitting);
          response[f.key] = r.value;
          if (r.error) errors.push(r.error);
        }
      } else if (item.kind === "checklist") {
        const allowed = new Set((item.config.checklist ?? []).map((c) => c.key));
        const checked = fd.getAll("checked").map(String).filter((k) => allowed.has(k));
        const notes: Record<string, string> = {};
        for (const k of allowed) {
          const n = String(fd.get(`note_${k}`) ?? "").trim().slice(0, 1000);
          if (n) notes[k] = n;
        }
        response = { checked, notes };
        if (submitting && checked.length < allowed.size)
          errors.push("Confirm every step before submitting. If one is stuck, leave a note and save, or message the team below.");
      } else if (item.kind === "question") {
        const answer = String(fd.get("answer") ?? "").trim().slice(0, 5000);
        response = { answer };
        if (submitting && !answer) errors.push("Write an answer before submitting.");
      } else if (item.kind === "signature") {
        response = { client_note: String(fd.get("client_note") ?? "").trim().slice(0, 1000), told_team_at: submitting ? new Date().toISOString() : undefined };
      } else if (item.kind === "file") {
        response = item.response ?? {};
        if (submitting) {
          const [{ n }] = await tx.q<{ n: number }>("select count(*)::int as n from documents where item_id = $1", [itemId]);
          if (n === 0) errors.push("Upload at least one file before submitting.");
        }
      } else {
        throw new Error("This item can't be edited here.");
      }
      if (errors.length) {
        // Keep what the client typed: save it as a draft so the re-rendered form shows it alongside the errors.
        if (item.kind !== "file" && item.status !== "submitted")
          await tx.q("update onboarding_items set response = $2, status = 'in_progress', updated_at = now() where id = $1", [
            itemId,
            JSON.stringify(response),
          ]);
        return { error: `${errors.slice(0, 4).join(" ")} Your answers so far were saved.` };
      }

      await tx.q(
        `update onboarding_items set response = $2, status = $3, updated_at = now(),
           submitted_at = case when $3 = 'submitted' then now() else submitted_at end where id = $1`,
        [itemId, JSON.stringify(response), submitting ? "submitted" : "in_progress"],
      );
      await audit(tx, ctx, submitting ? "item.submitted" : "item.saved", "item", itemId, `${submitting ? "Submitted" : "Saved progress on"} "${item.title}"`);
      return { ok: submitting ? "Submitted. The team will review it and let you know if anything else is needed." : "Progress saved." };
    });
    revalidatePath("/portal", "layout");
    return result;
  } catch (e) {
    return fail(e);
  }
}

export async function clientUploadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("client");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };
    const result = await uploadDocument(tenantCtx(auth), {
      itemId: String(fd.get("itemId") ?? ""),
      documentId: (fd.get("documentId") as string) || null,
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
    if (!result.ok) return { error: result.error };
    revalidatePath("/portal", "layout");
    return { ok: "Uploaded. Submit when you've added everything." };
  } catch (e) {
    return fail(e);
  }
}

export async function clientCommentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("client");
    const ctx = tenantCtx(auth);
    const body = String(fd.get("body") ?? "").trim();
    if (!body) return { error: "Write a message first." };
    await withTenant(ctx, async (tx) => {
      const onboarding = await tx.one<{ id: string }>("select id from onboardings where id = $1", [String(fd.get("onboardingId") ?? "")]);
      if (!onboarding) throw new Error("Not found.");
      await tx.q(
        "insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body) values ($1,$2,$3,$4,$5,'client',$6)",
        [auth.workspace.id, auth.clientId, onboarding.id, (fd.get("itemId") as string) || null, auth.user.id, body.slice(0, 5000)],
      );
      await audit(tx, ctx, "comment.client", "onboarding", onboarding.id, "Client posted a message");
    });
    revalidatePath("/portal", "layout");
    return { ok: "Sent to the team." };
  } catch (e) {
    return fail(e);
  }
}
