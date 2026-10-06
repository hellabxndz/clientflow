import { z } from "zod";
import type { Tx } from "./db";

export const ITEM_KINDS = ["form", "file", "checklist", "question", "task", "signature"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const FIELD_TYPES = ["text", "textarea", "email", "url", "phone", "number", "date", "select", "multiselect"] as const;

const key = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9_-]+$/, "Keys may only use lowercase letters, numbers, - and _");

export const formFieldSchema = z.object({
  key,
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  help: z.string().max(500).optional(),
  options: z.array(z.string().min(1).max(120)).max(50).optional(),
});

export const templateItemSchema = z.object({
  key,
  kind: z.enum(ITEM_KINDS),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  audience: z.enum(["client", "internal"]),
  required: z.boolean().default(true),
  dueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
  assignee: z
    .union([z.object({ type: z.literal("onboarding_owner") }), z.object({ type: z.literal("user"), userId: z.string().uuid() })])
    .nullable()
    .optional(),
  dependsOn: z.array(key).max(20).optional(),
  fields: z.array(formFieldSchema).max(40).optional(),
  file: z
    .object({
      accept: z.array(z.string().min(1).max(20)).min(1).max(20),
      maxSizeMb: z.number().int().min(1).max(100),
      maxFiles: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
  checklist: z
    .array(z.object({ key, label: z.string().min(1).max(200), help: z.string().max(1000).optional() }))
    .max(30)
    .optional(),
  signature: z.object({ provider: z.string().max(80).optional(), instructions: z.string().max(1000) }).optional(),
});

export const templateContentSchema = z
  .object({
    sections: z
      .array(
        z.object({
          key,
          title: z.string().min(1).max(200),
          description: z.string().max(1000).optional(),
          items: z.array(templateItemSchema).max(60),
        }),
      )
      .max(30),
  })
  .superRefine((content, ctx) => {
    const keys = new Set<string>();
    for (const section of content.sections) {
      for (const item of section.items) {
        if (keys.has(item.key)) ctx.addIssue({ code: "custom", message: `Duplicate item key "${item.key}"` });
        keys.add(item.key);
        if (item.kind === "form" && (!item.fields || item.fields.length === 0))
          ctx.addIssue({ code: "custom", message: `Form "${item.title}" needs at least one field` });
        if (item.kind === "file" && !item.file)
          ctx.addIssue({ code: "custom", message: `File request "${item.title}" needs file rules` });
        if (item.kind === "checklist" && (!item.checklist || item.checklist.length === 0))
          ctx.addIssue({ code: "custom", message: `Checklist "${item.title}" needs at least one entry` });
        if (item.kind === "task" && item.audience !== "internal")
          ctx.addIssue({ code: "custom", message: `Task "${item.title}" must be internal` });
      }
    }
    for (const section of content.sections) {
      for (const item of section.items) {
        for (const dep of item.dependsOn ?? []) {
          if (!keys.has(dep)) ctx.addIssue({ code: "custom", message: `"${item.title}" depends on unknown item "${dep}"` });
          if (dep === item.key) ctx.addIssue({ code: "custom", message: `"${item.title}" cannot depend on itself` });
        }
      }
    }
    if (hasCycle(content)) ctx.addIssue({ code: "custom", message: "Dependencies contain a cycle" });
  });

export type TemplateContent = z.infer<typeof templateContentSchema>;
export type TemplateItem = z.infer<typeof templateItemSchema>;
export type FormField = z.infer<typeof formFieldSchema>;

function hasCycle(content: { sections: { items: { key: string; dependsOn?: string[] }[] }[] }) {
  const graph = new Map<string, string[]>();
  for (const s of content.sections) for (const i of s.items) graph.set(i.key, i.dependsOn ?? []);
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of graph.get(k) ?? []) if (graph.has(d) && visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  return [...graph.keys()].some(visit);
}

const PASSWORD_PATTERN = /\b(password|passcode|passwd|pwd)\b/i;

/** Flags fields that would ask clients for credentials. Clients must never upload passwords. */
export function findCredentialRequests(content: TemplateContent): string[] {
  const problems: string[] = [];
  for (const s of content.sections)
    for (const item of s.items)
      for (const f of item.fields ?? [])
        if (PASSWORD_PATTERN.test(f.label) || PASSWORD_PATTERN.test(f.key))
          problems.push(`"${f.label}" in "${item.title}" looks like it asks for a password. Use delegated access instead.`);
  return problems;
}

export function validateTemplateContent(raw: unknown):
  | { ok: true; content: TemplateContent }
  | { ok: false; errors: string[] } {
  const parsed = templateContentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  const creds = findCredentialRequests(parsed.data);
  if (creds.length) return { ok: false, errors: creds };
  return { ok: true, content: parsed.data };
}

/** Publishes the template's draft as a new immutable version. */
export async function publishTemplate(tx: Tx, templateId: string, userId: string | null, note?: string) {
  const tpl = await tx.one<{ id: string; workspace_id: string; draft: unknown; current_version: number }>(
    "select id, workspace_id, draft, current_version from templates where id = $1 for update",
    [templateId],
  );
  if (!tpl) throw new Error("Template not found");
  const valid = validateTemplateContent(tpl.draft);
  if (!valid.ok) throw new Error(valid.errors.join("; "));
  const version = tpl.current_version + 1;
  const row = await tx.one<{ id: string }>(
    `insert into template_versions (workspace_id, template_id, version, content, change_note, published_by)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [tpl.workspace_id, tpl.id, version, JSON.stringify(valid.content), note ?? null, userId],
  );
  await tx.q("update templates set current_version = $2, updated_at = now() where id = $1", [tpl.id, version]);
  return { versionId: row!.id, version };
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Creates an onboarding from the latest published version of a template. The items are
 * copied into the onboarding so later template edits never change existing requirements.
 */
export async function createOnboardingFromTemplate(
  tx: Tx,
  input: {
    workspaceId: string;
    clientId: string;
    templateId: string;
    ownerUserId: string | null;
    name?: string;
    startDate?: Date;
    targetDate?: Date | null;
  },
) {
  const tv = await tx.one<{ id: string; version: number; content: TemplateContent; name: string }>(
    `select v.id, v.version, v.content, t.name from template_versions v join templates t on t.id = v.template_id
     where v.template_id = $1 order by v.version desc limit 1`,
    [input.templateId],
  );
  if (!tv) throw new Error("Publish the template before using it for an onboarding.");
  const start = input.startDate ?? new Date();
  // Due dates fall at 5pm UTC on the offset day; reminders are scheduled in the client's time zone.
  const startDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 17));

  const onboarding = await tx.one<{ id: string }>(
    `insert into onboardings (workspace_id, client_id, template_id, template_version_id, template_version, template_name,
       name, start_date, target_date, owner_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      input.workspaceId,
      input.clientId,
      input.templateId,
      tv.id,
      tv.version,
      tv.name,
      input.name ?? tv.name,
      start.toISOString().slice(0, 10),
      input.targetDate ? input.targetDate.toISOString().slice(0, 10) : null,
      input.ownerUserId,
    ],
  );

  let position = 0;
  for (const section of tv.content.sections) {
    for (const item of section.items) {
      const owner =
        item.assignee?.type === "user"
          ? item.assignee.userId
          : item.assignee?.type === "onboarding_owner" || item.audience === "internal"
            ? input.ownerUserId
            : null;
      const config = {
        fields: item.fields,
        file: item.file,
        checklist: item.checklist,
        signature: item.signature,
      };
      await tx.q(
        `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key,
           position, kind, title, description, audience, required, due_at, owner_user_id, depends_on, config)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          input.workspaceId,
          input.clientId,
          onboarding!.id,
          section.key,
          section.title,
          item.key,
          position++,
          item.kind,
          item.title,
          item.description ?? null,
          item.audience,
          item.required,
          item.dueOffsetDays == null ? null : addDays(startDay, item.dueOffsetDays).toISOString(),
          owner,
          item.dependsOn ?? [],
          JSON.stringify(config),
        ],
      );
    }
  }
  return { onboardingId: onboarding!.id, templateVersion: tv.version };
}
