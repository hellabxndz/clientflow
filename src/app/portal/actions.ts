"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { afterWrite } from "@/lib/action-helpers";
import { uploadDocument } from "@/lib/files";
import { unmetDependencies, type ItemLike } from "@/lib/onboarding";
import { asksForPassword, SENSITIVE_CATEGORIES, type FormField } from "@/lib/templates";
import { validateField } from "@/lib/form-validation";
import type { ActionState } from "@/components/forms";

const NO_PASSWORDS = "Please don't share passwords. Use the invitation steps above instead.";

function fail(e: unknown): ActionState {
  const message = e instanceof Error ? e.message : "Something went wrong.";
  if (/under review are locked/i.test(message)) return { error: "This item is being reviewed by the team, so it can't be changed right now." };
  if (/approved items are locked/i.test(message)) return { error: "This item is already approved." };
  if (/row-level security|permission denied|clients may only|clients cannot/i.test(message)) return { error: "You don't have access to change that." };
  return { error: message };
}

/**
 * Heuristic for text that shares a password or other login secret. Used on every free-text value a
 * client sends with access requests and checklists, and on the clearest patterns everywhere else.
 */
function sharesCredential(text: string, strict: boolean) {
  const t = text.trim();
  if (!t) return false;
  // "password: x", "pwd = x", "login is x", "username/password ..."
  if (/\b(password|passcode|passwd|pwd|pass word)\b\s*(is|was|=|:)\s*\S/i.test(t)) return true;
  if (/\b(login|credentials?|2fa code|otp|pin)\s*[:=]\s*\S/i.test(t)) return true;
  if (/\b(user ?name|user|email)\s*[:=]\s*\S+.*\b(password|pass|pwd)\b/i.test(t)) return true;
  if (!strict) return false;
  if (/\b(my|our|the|here'?s? (is )?the|here are the)\s+(password|passcode|passwd|pwd|login details|credentials)\b/i.test(t) && !/\b(never|don't|do not|won't|not)\b/i.test(t))
    return true;
  if (asksForPassword(t)) return true;
  // A single token mixing letters, digits and symbols looks like a secret, not an account ID.
  return t.split(/\s+/).some((w) => w.length >= 8 && /[A-Za-z]/.test(w) && /\d/.test(w) && /[!@#$%^&*?~+=]/.test(w) && !/^https?:/i.test(w) && !w.includes("@"));
}

type PortalItem = ItemLike & {
  onboarding_id: string;
  config: {
    fields?: FormField[];
    checklist?: { key: string; label: string }[];
    access?: { accountIdLabel?: string };
  };
  response: Record<string, unknown>;
  onboarding_status: string;
  review_required: boolean;
  category: string | null;
};

/** Returns a reason the client can't change this item right now, or null. */
function lockedReason(item: PortalItem) {
  if (item.audience !== "client") return "This request isn't available.";
  if (item.status === "approved") return "This item is already approved.";
  if (item.status === "under_review") return "This item is being reviewed by the team, so it can't be changed right now.";
  if (item.onboarding_status === "completed" || item.onboarding_status === "cancelled") return "This onboarding is closed.";
  return null;
}

export async function saveItemAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("client");
    const ctx = tenantCtx(auth);
    const itemId = String(fd.get("itemId") ?? "");
    const submitting = fd.get("intent") === "submit";
    const result = await withTenant(ctx, async (tx) => {
      const item = await tx.one<PortalItem>(
        `select i.*, o.status as onboarding_status from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where i.id = $1 and i.audience = 'client' and i.removed_at is null`,
        [itemId],
      );
      if (!item) throw new Error("This request isn't available.");
      const locked = lockedReason(item);
      if (locked) throw new Error(locked);
      const siblings = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
      if (unmetDependencies(item, new Map(siblings.map((s) => [s.item_key, s]))).length)
        throw new Error("This item opens once the earlier steps are approved.");

      let response: Record<string, unknown> = {};
      const errors: string[] = [];
      let credential = false;
      if (item.kind === "form") {
        for (const f of item.config.fields ?? []) {
          const raw = f.type === "multiselect" ? fd.getAll(`f_${f.key}`) : fd.get(`f_${f.key}`);
          const r = validateField(f, raw, submitting);
          response[f.key] = r.value;
          if (typeof r.value === "string" && sharesCredential(r.value, false)) credential = true;
          if (r.error) errors.push(r.error);
        }
      } else if (item.kind === "checklist") {
        const allowed = new Set((item.config.checklist ?? []).map((c) => c.key));
        const checked = fd.getAll("checked").map(String).filter((k) => allowed.has(k));
        const notes: Record<string, string> = {};
        for (const k of allowed) {
          const n = String(fd.get(`note_${k}`) ?? "").trim().slice(0, 1000);
          if (n) notes[k] = n;
          if (sharesCredential(n, true)) credential = true;
        }
        response = { checked, notes };
        if (submitting && checked.length < allowed.size)
          errors.push("Confirm every step before submitting. If one is stuck, leave a note and save, or message the team below.");
      } else if (item.kind === "question") {
        const answer = String(fd.get("answer") ?? "").trim().slice(0, 5000);
        response = { answer };
        if (sharesCredential(answer, false)) credential = true;
        if (submitting && !answer) errors.push("Write an answer before submitting.");
      } else if (item.kind === "access") {
        const confirmed = fd.get("confirmed") === "on" || fd.get("confirmed") === "true";
        const accountId = String(fd.get("accountId") ?? "").trim().slice(0, 120);
        const note = String(fd.get("note") ?? "").trim().slice(0, 1000);
        if (sharesCredential(accountId, true) || sharesCredential(note, true)) credential = true;
        response = { confirmed, ...(accountId ? { accountId } : {}), ...(note ? { note } : {}) };
        if (submitting && !confirmed) errors.push("Tick \"I've sent the invitation\" once you've followed the steps, or save your progress for later.");
      } else if (item.kind === "signature") {
        const note = String(fd.get("client_note") ?? "").trim().slice(0, 1000);
        if (sharesCredential(note, false)) credential = true;
        response = { client_note: note, told_team_at: submitting ? new Date().toISOString() : undefined };
      } else if (item.kind === "file") {
        response = item.response ?? {};
        if (submitting) {
          const [{ n }] = await tx.q<{ n: number }>("select count(*)::int as n from documents where item_id = $1", [itemId]);
          if (n === 0) errors.push("Upload at least one file before submitting.");
        }
      } else {
        throw new Error("This item can't be edited here.");
      }

      // Never store anything that looks like a password, not even as a draft.
      if (credential) return { error: NO_PASSWORDS };

      if (errors.length) {
        // Keep what the client typed: save it as a draft so the re-rendered form shows it alongside the errors
        // (React 19 resets uncontrolled forms after an action).
        if (item.kind !== "file" && item.status !== "submitted") {
          await tx.q("update onboarding_items set response = $2, status = 'in_progress', updated_at = now() where id = $1", [itemId, JSON.stringify(response)]);
          return { error: `${errors.slice(0, 4).join(" ")} Your answers so far were saved.`, data: { wrote: true } };
        }
        return { error: errors.slice(0, 4).join(" ") };
      }

      await tx.q(
        `update onboarding_items set response = $2, status = $3, updated_at = now(),
           submitted_at = case when $3 = 'submitted' then now() else submitted_at end where id = $1`,
        [itemId, JSON.stringify(response), submitting ? "submitted" : "in_progress"],
      );
      await audit(tx, ctx, submitting ? "item.submitted" : "item.saved", "item", itemId, `${submitting ? "Submitted" : "Saved progress on"} "${item.title}"`);
      const autoApprove = submitting && !item.review_required && !(item.category && SENSITIVE_CATEGORIES.has(item.category));
      return {
        ok: submitting
          ? autoApprove
            ? "Submitted. Thanks, this one is done."
            : "Submitted. The team will review it and let you know if anything else is needed."
          : "Progress saved.",
        data: { wrote: true, autoApprove },
      };
    });

    const data = result.data as { wrote?: boolean; autoApprove?: boolean } | undefined;
    if (data?.autoApprove) await autoApproveItem(auth.workspace.id, itemId);
    if (data?.wrote) {
      await afterWrite(auth.workspace.id);
      revalidatePath("/portal", "layout");
    }
    return { ok: result.ok, error: result.error };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Items that don't need review are approved by the system right after the client submits. Clients can't
 * set "approved" themselves (the database refuses it), so this runs with the system role after re-checking
 * the rules: never for sensitive (legal, financial, tax, identity) items.
 */
async function autoApproveItem(workspaceId: string, itemId: string) {
  const sys = { workspaceId, userId: null, role: "system" as const };
  await withTenant(sys, async (tx) => {
    const item = await tx.one<{ id: string; title: string; kind: string; review_required: boolean; category: string | null; status: string }>(
      "select id, title, kind, review_required, category, status from onboarding_items where id = $1 for update",
      [itemId],
    );
    if (!item || item.status !== "submitted" || item.review_required || (item.category && SENSITIVE_CATEGORIES.has(item.category))) return;
    await tx.q("update onboarding_items set status = 'approved', reviewed_at = now(), reviewed_by = null, updated_at = now() where id = $1", [itemId]);
    if (item.kind === "file")
      await tx.q(
        `update document_versions v set review_status = 'approved', reviewed_at = now()
         from documents d where d.id = v.document_id and d.item_id = $1 and v.review_status = 'pending'`,
        [itemId],
      );
    await audit(tx, sys, "item.auto_approved", "item", itemId, `"${item.title}" was approved automatically (no review required)`);
  });
}

export async function clientUploadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("client");
    const ctx = tenantCtx(auth);
    const itemId = String(fd.get("itemId") ?? "");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };
    const check = await withTenant(ctx, async (tx) => {
      const item = await tx.one<PortalItem>(
        `select i.*, o.status as onboarding_status from onboarding_items i join onboardings o on o.id = i.onboarding_id
         where i.id = $1 and i.audience = 'client' and i.removed_at is null`,
        [itemId],
      );
      if (!item) return "This request isn't available.";
      const locked = lockedReason(item);
      if (locked) return locked;
      const siblings = await tx.q<ItemLike>("select * from onboarding_items where onboarding_id = $1", [item.onboarding_id]);
      if (unmetDependencies(item, new Map(siblings.map((s) => [s.item_key, s]))).length) return "This item opens once the earlier steps are approved.";
      return null;
    });
    if (check) return { error: check };
    const result = await uploadDocument(ctx, {
      itemId,
      documentId: (fd.get("documentId") as string) || null,
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
    });
    if (!result.ok) return { error: result.error };
    await afterWrite(auth.workspace.id);
    revalidatePath("/portal", "layout");
    return { ok: fd.get("documentId") ? "New version uploaded. Submit it when you're ready." : "Uploaded. Submit when you've added everything." };
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
    if (sharesCredential(body, false)) return { error: NO_PASSWORDS };
    await withTenant(ctx, async (tx) => {
      const onboarding = await tx.one<{ id: string }>("select id from onboardings where id = $1", [String(fd.get("onboardingId") ?? "")]);
      if (!onboarding) throw new Error("Not found.");
      const itemId = (fd.get("itemId") as string) || null;
      if (itemId) {
        const item = await tx.one("select id from onboarding_items where id = $1 and onboarding_id = $2 and audience = 'client'", [itemId, onboarding.id]);
        if (!item) throw new Error("Not found.");
      }
      await tx.q(
        "insert into comments (workspace_id, client_id, onboarding_id, item_id, author_user_id, visibility, body) values ($1,$2,$3,$4,$5,'client',$6)",
        [auth.workspace.id, auth.clientId, onboarding.id, itemId, auth.user.id, body.slice(0, 5000)],
      );
      await audit(tx, ctx, "comment.client", itemId ? "item" : "onboarding", itemId ?? onboarding.id, "Client posted a message");
    });
    await afterWrite(auth.workspace.id);
    revalidatePath("/portal", "layout");
    return { ok: "Sent to the team." };
  } catch (e) {
    return fail(e);
  }
}
