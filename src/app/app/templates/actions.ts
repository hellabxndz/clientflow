"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant, type Tx } from "@/lib/db";
import { tenantCtx, type AuthContext } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, optional, str } from "@/lib/action-helpers";
import { publishTemplate, SENSITIVE_CATEGORIES, validateTemplateContent, type TemplateContent } from "@/lib/templates";
import { ACCOUNTING_TEMPLATE, AGENCY_WORKFLOWS, BLANK_TEMPLATE, type LibraryTemplate } from "@/lib/template-library";
import type { ActionState } from "@/components/forms";
import { canEditTemplates, TEMPLATE_EDIT_DENIED } from "./permissions";

async function editorAuth() {
  const auth = await actionAuth("staff");
  if (!canEditTemplates(auth)) throw new Error(TEMPLATE_EDIT_DENIED);
  return auth;
}

function librarySource(source: string): { base: LibraryTemplate; label: string } {
  const m = /^workflow:(\d+)$/.exec(source);
  if (m && AGENCY_WORKFLOWS[Number(m[1])]) return { base: AGENCY_WORKFLOWS[Number(m[1])], label: AGENCY_WORKFLOWS[Number(m[1])].name };
  if (source === "accounting") return { base: ACCOUNTING_TEMPLATE, label: ACCOUNTING_TEMPLATE.name };
  return { base: { name: "Untitled template", description: "", category: "general", content: BLANK_TEMPLATE }, label: "blank" };
}

export async function createFromLibraryAction(fd: FormData) {
  const auth = await editorAuth();
  const ctx = tenantCtx(auth);
  const source = str(fd, "source");
  const { base, label } = librarySource(source);
  const id = await withTenant(ctx, async (tx) => {
    const taken = await tx.one("select 1 from templates where name = $1", [base.name]);
    const name = source === "blank" || !source ? "Untitled template" : taken ? `${base.name} (copy)` : base.name;
    const row = await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [auth.workspace.id, name, base.description, base.category, JSON.stringify(base.content), auth.user.id],
    );
    await audit(tx, ctx, "template.created", "template", row!.id, `Created template "${name}" from ${label === "blank" ? "a blank template" : `the library (${label})`}`);
    return row!.id;
  });
  revalidatePath("/app/templates");
  redirect(`/app/templates/${id}`);
}

export async function duplicateTemplate(fd: FormData) {
  const auth = await editorAuth();
  const ctx = tenantCtx(auth);
  const id = await withTenant(ctx, async (tx) => {
    const t = await tx.one<{ name: string; description: string | null; category: string; draft: unknown }>(
      "select name, description, category, draft from templates where id = $1",
      [str(fd, "templateId")],
    );
    if (!t) throw new Error("Template not found");
    const row = await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, description, category, draft, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
      [auth.workspace.id, `${t.name} (copy)`, t.description, t.category, JSON.stringify(t.draft), auth.user.id],
    );
    await audit(tx, ctx, "template.duplicated", "template", row!.id, `Duplicated template "${t.name}"`);
    return row!.id;
  });
  revalidatePath("/app/templates");
  redirect(`/app/templates/${id}`);
}

/** Server-side rules on top of the schema: sensitive items always need human review, and people referenced must be staff here. */
async function normalizeContent(tx: Tx, content: TemplateContent): Promise<{ content: TemplateContent; errors: string[] }> {
  const staff = new Set(
    (await tx.q<{ user_id: string }>("select user_id from memberships where role in ('admin', 'manager', 'staff')")).map((r) => r.user_id),
  );
  const errors: string[] = [];
  for (const s of content.sections)
    for (const item of s.items) {
      if (item.category && SENSITIVE_CATEGORIES.has(item.category)) item.review = { required: true, reviewer: item.review?.reviewer ?? null };
      if (item.kind === "access" && !item.category) item.category = "access";
      if (item.audience === "internal" && item.review) delete item.review;
      if (item.assignee?.type === "user" && !staff.has(item.assignee.userId)) errors.push(`The assignee of "${item.title}" is no longer on the team.`);
      if (item.review?.reviewer?.type === "user" && !staff.has(item.review.reviewer.userId)) errors.push(`The reviewer of "${item.title}" is no longer on the team.`);
      if (item.dueAfterDependencyDays != null && !(item.dependsOn?.length))
        errors.push(`"${item.title}" is due a number of days after its dependencies, but has none. Pick dependencies or use a fixed due day.`);
    }
  return { content, errors };
}

export async function saveTemplate(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await editorAuth();
    const ctx = tenantCtx(auth);
    const id = str(fd, "templateId");
    const name = str(fd, "name");
    const publish = fd.get("publish") === "1";
    if (!name) return { error: "Template name is required." };
    if (name.length > 200) return { error: "Template name is too long." };
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "content"));
    } catch {
      return { error: "Template content is not valid." };
    }
    // validateTemplateContent also rejects anything that asks clients for passwords, so such content can't be saved or published.
    const valid = validateTemplateContent(raw);
    if (!valid.ok) return { error: valid.errors.slice(0, 5).join(" ") };
    const result = await withTenant(ctx, async (tx) => {
      const { content, errors } = await normalizeContent(tx, valid.content);
      if (errors.length) return { error: errors.slice(0, 5).join(" ") };
      const t = await tx.one<{ id: string }>(
        "update templates set name = $2, description = $3, category = $4, draft = $5, updated_at = now() where id = $1 returning id",
        [id, name, optional(fd, "description"), str(fd, "category") || "general", JSON.stringify(content)],
      );
      if (!t) throw new Error("Template not found.");
      await audit(tx, ctx, "template.saved", "template", id, `Saved draft of "${name}"`);
      if (publish) {
        const { version } = await publishTemplate(tx, id, auth.user.id, optional(fd, "changeNote") ?? undefined);
        await audit(tx, ctx, "template.published", "template", id, `Published "${name}" v${version}`);
        return { ok: `Published v${version}. New onboardings use this version. Live onboardings keep their own copy until someone upgrades them from the client page.` };
      }
      return { ok: "Draft saved. Publish to make it available for new onboardings." };
    });
    revalidatePath(`/app/templates/${id}`);
    revalidatePath("/app/templates");
    return result;
  } catch (e) {
    return fail(e);
  }
}

export async function archiveTemplate(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth: AuthContext = await editorAuth();
    const ctx = tenantCtx(auth);
    const id = str(fd, "templateId");
    const archived = str(fd, "archived") === "true";
    await withTenant(ctx, async (tx) => {
      const t = await tx.one("update templates set archived = $2, updated_at = now() where id = $1 returning id", [id, archived]);
      if (!t) throw new Error("Template not found.");
      await audit(tx, ctx, archived ? "template.archived" : "template.restored", "template", id, archived ? "Archived template" : "Restored template");
    });
    revalidatePath("/app/templates");
    revalidatePath(`/app/templates/${id}`);
    return { ok: archived ? "Archived. Live onboardings are not affected." : "Restored." };
  } catch (e) {
    return fail(e);
  }
}
