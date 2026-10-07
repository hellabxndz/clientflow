import { z } from "zod";
import type { Tx } from "./db";

export const ITEM_KINDS = ["form", "file", "checklist", "question", "task", "signature", "access"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Document categories. Legal, financial, tax and identity documents always require human review. */
export const DOC_CATEGORIES = ["brand", "creative", "legal", "financial", "tax", "identity", "access", "operations", "general"] as const;
export const SENSITIVE_CATEGORIES = new Set(["legal", "financial", "tax", "identity"]);

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
  access: z
    .object({
      platform: z.string().min(1).max(80),
      instructions: z.string().min(1).max(3000),
      inviteEmail: z.string().email().max(200).optional(),
      accessLevel: z.string().max(80).optional(),
      helpUrl: z.string().url().max(500).optional(),
      accountIdLabel: z.string().max(80).optional(),
    })
    .optional(),
  weight: z.number().int().min(1).max(10).optional(),
  critical: z.boolean().optional(),
  category: z.enum(DOC_CATEGORIES).optional(),
  review: z
    .object({
      required: z.boolean(),
      reviewer: z
        .union([z.object({ type: z.literal("onboarding_owner") }), z.object({ type: z.literal("user"), userId: z.string().uuid() })])
        .nullable()
        .optional(),
    })
    .optional(),
  dueAfterDependencyDays: z.number().int().min(0).max(120).nullable().optional(),
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
        if (item.kind === "access" && !item.access)
          ctx.addIssue({ code: "custom", message: `Access request "${item.title}" needs a platform and delegated-access instructions` });
        if (item.kind === "access" && item.audience !== "client")
          ctx.addIssue({ code: "custom", message: `Access request "${item.title}" must be a client item` });
        if (item.category && SENSITIVE_CATEGORIES.has(item.category) && item.review && !item.review.required)
          ctx.addIssue({ code: "custom", message: `"${item.title}" is a ${item.category} document and must be reviewed by a person` });
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

/** True when a sentence asks someone to hand over a password (warnings like "never share your password" are fine). */
export function asksForPassword(text: string) {
  return text
    .split(/[.!?\n]+/)
    .some(
      (sentence) =>
        /\b(enter|share|send|provide|type|upload|give us|tell us)\b[^.]*\b(password|passcode|login details|credentials)\b/i.test(sentence) &&
        !/\b(never|don't|do not|no need|not)\b/i.test(sentence),
    );
}

/** Flags fields that would ask clients for credentials. Clients must never upload passwords. */
export function findCredentialRequests(content: TemplateContent): string[] {
  const problems: string[] = [];
  for (const s of content.sections)
    for (const item of s.items) {
      for (const f of item.fields ?? [])
        if (PASSWORD_PATTERN.test(f.label) || PASSWORD_PATTERN.test(f.key))
          problems.push(`"${f.label}" in "${item.title}" looks like it asks for a password. Use delegated access instead.`);
      for (const c of item.checklist ?? [])
        if (asksForPassword(c.label))
          problems.push(`"${c.label}" in "${item.title}" asks for a password. Use delegated access instead.`);
      if (item.description && asksForPassword(item.description))
        problems.push(`The description of "${item.title}" asks for a password. Use delegated access instead.`);
      if (item.access && asksForPassword(item.access.instructions))
        problems.push(`The instructions for "${item.title}" ask for a password. Use delegated access instead.`);
    }
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

/** Due dates fall at 5pm UTC on the offset day; reminders are scheduled in the client's time zone. */
export function dueFromOffset(start: Date | string, offsetDays: number | null | undefined) {
  if (offsetDays == null) return null;
  const s = new Date(start);
  const startDay = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), 17));
  return addDays(startDay, offsetDays);
}

function itemConfig(item: TemplateItem) {
  return {
    fields: item.fields,
    file: item.file,
    checklist: item.checklist,
    signature: item.signature,
    access: item.access,
    dueAfterDependencyDays: item.dueAfterDependencyDays ?? undefined,
  };
}

function resolveUser(
  ref: { type: "onboarding_owner" } | { type: "user"; userId: string } | null | undefined,
  ownerUserId: string | null,
) {
  if (!ref) return null;
  return ref.type === "user" ? ref.userId : ownerUserId;
}

/** Column values for an onboarding item copied from a template item. */
function itemColumns(item: TemplateItem, ownerUserId: string | null, start: Date | string) {
  const owner = item.assignee ? resolveUser(item.assignee, ownerUserId) : item.audience === "internal" ? ownerUserId : null;
  const reviewRequired = item.review?.required ?? true;
  const reviewer = item.review?.reviewer ? resolveUser(item.review.reviewer, ownerUserId) : null;
  return {
    kind: item.kind,
    title: item.title,
    description: item.description ?? null,
    audience: item.audience,
    required: item.required,
    // Items that wait on a dependency get their due date when the dependency is approved.
    due_at: item.dueAfterDependencyDays != null && (item.dependsOn?.length ?? 0) > 0 ? null : dueFromOffset(start, item.dueOffsetDays),
    owner_user_id: owner,
    depends_on: item.dependsOn ?? [],
    config: itemConfig(item),
    weight: item.weight ?? 1,
    critical: item.critical ?? false,
    review_required: item.category && SENSITIVE_CATEGORIES.has(item.category) ? true : reviewRequired,
    reviewer_user_id: reviewer,
    category: item.category ?? (item.kind === "access" ? "access" : null),
  };
}

async function insertItem(
  tx: Tx,
  ids: { workspaceId: string; clientId: string; onboardingId: string },
  section: { key: string; title: string },
  item: TemplateItem,
  position: number,
  ownerUserId: string | null,
  start: Date | string,
  version: number,
) {
  const c = itemColumns(item, ownerUserId, start);
  await tx.q(
    `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key,
       position, kind, title, description, audience, required, due_at, owner_user_id, depends_on, config,
       weight, critical, review_required, reviewer_user_id, category, source_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      ids.workspaceId, ids.clientId, ids.onboardingId, section.key, section.title, item.key, position,
      c.kind, c.title, c.description, c.audience, c.required, c.due_at?.toISOString() ?? null, c.owner_user_id,
      c.depends_on, JSON.stringify(c.config), c.weight, c.critical, c.review_required, c.reviewer_user_id, c.category, version,
    ],
  );
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
    source?: string;
  },
) {
  const tv = await tx.one<{ id: string; version: number; content: TemplateContent; name: string }>(
    `select v.id, v.version, v.content, t.name from template_versions v join templates t on t.id = v.template_id
     where v.template_id = $1 order by v.version desc limit 1`,
    [input.templateId],
  );
  if (!tv) throw new Error("Publish the template before using it for an onboarding.");
  const start = input.startDate ?? new Date();

  const onboarding = await tx.one<{ id: string }>(
    `insert into onboardings (workspace_id, client_id, template_id, template_version_id, template_version, template_name,
       name, start_date, target_date, owner_user_id, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
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
      input.source ?? "manual",
    ],
  );

  let position = 0;
  for (const section of tv.content.sections)
    for (const item of section.items)
      await insertItem(
        tx,
        { workspaceId: input.workspaceId, clientId: input.clientId, onboardingId: onboarding!.id },
        section,
        item,
        position++,
        input.ownerUserId,
        start,
        tv.version,
      );
  return { onboardingId: onboarding!.id, templateVersion: tv.version };
}

// ---------------------------------------------------------------------------
// Explicit template upgrades for live onboardings
// ---------------------------------------------------------------------------

export interface UpgradePlan {
  onboardingId: string;
  fromVersion: number | null;
  toVersion: number;
  toVersionId: string;
  added: { key: string; title: string; section: string }[];
  updated: { key: string; title: string; changes: string[] }[];
  keptStarted: { key: string; title: string; reason: string }[];
  removed: { key: string; title: string }[];
  keptRemoved: { key: string; title: string; reason: string }[];
}

interface LiveItem {
  id: string;
  item_key: string;
  title: string;
  description: string | null;
  status: string;
  required: boolean;
  weight: number;
  critical: boolean;
  config: unknown;
  depends_on: string[];
  due_at: Date | null;
  removed_at: Date | null;
  doc_count: number;
}

function diffItem(cur: LiveItem, next: TemplateItem) {
  const changes: string[] = [];
  if (cur.title !== next.title) changes.push(`title "${cur.title}" → "${next.title}"`);
  if ((cur.description ?? "") !== (next.description ?? "")) changes.push("description");
  if (cur.required !== next.required) changes.push(next.required ? "now required" : "now optional");
  if (cur.weight !== (next.weight ?? 1)) changes.push(`weight ${cur.weight} → ${next.weight ?? 1}`);
  if (cur.critical !== (next.critical ?? false)) changes.push(next.critical ? "now critical" : "no longer critical");
  if (JSON.stringify(cur.depends_on) !== JSON.stringify(next.dependsOn ?? [])) changes.push("dependencies");
  if (JSON.stringify(cur.config) !== JSON.stringify(JSON.parse(JSON.stringify(itemConfig(next))))) changes.push("questions or instructions");
  return changes;
}

/** Works out what upgrading an onboarding to its template's latest version would change. Nothing is written. */
export async function planTemplateUpgrade(tx: Tx, onboardingId: string): Promise<UpgradePlan | null> {
  const onb = await tx.one<{ id: string; template_id: string | null; template_version: number | null }>(
    "select id, template_id, template_version from onboardings where id = $1",
    [onboardingId],
  );
  if (!onb?.template_id) return null;
  const tv = await tx.one<{ id: string; version: number; content: TemplateContent }>(
    "select id, version, content from template_versions where template_id = $1 order by version desc limit 1",
    [onb.template_id],
  );
  if (!tv || tv.version === onb.template_version) return null;
  const prev = onb.template_version
    ? await tx.one<{ content: TemplateContent }>("select content from template_versions where template_id = $1 and version = $2", [
        onb.template_id,
        onb.template_version,
      ])
    : null;
  const prevKeys = new Set(prev?.content.sections.flatMap((s) => s.items.map((i) => i.key)) ?? []);
  const items = await tx.q<LiveItem>(
    `select i.id, i.item_key, i.title, i.description, i.status, i.required, i.weight, i.critical, i.config, i.depends_on, i.due_at,
            i.removed_at, (select count(*)::int from documents d where d.item_id = i.id) as doc_count
     from onboarding_items i where i.onboarding_id = $1`,
    [onboardingId],
  );
  const byKey = new Map(items.map((i) => [i.item_key, i]));
  const plan: UpgradePlan = {
    onboardingId,
    fromVersion: onb.template_version,
    toVersion: tv.version,
    toVersionId: tv.id,
    added: [],
    updated: [],
    keptStarted: [],
    removed: [],
    keptRemoved: [],
  };
  const nextKeys = new Set<string>();
  for (const section of tv.content.sections)
    for (const item of section.items) {
      nextKeys.add(item.key);
      const cur = byKey.get(item.key);
      if (!cur || cur.removed_at) {
        plan.added.push({ key: item.key, title: item.title, section: section.title });
        continue;
      }
      const changes = diffItem(cur, item);
      if (changes.length === 0) continue;
      if (cur.status === "not_started" && cur.doc_count === 0) plan.updated.push({ key: item.key, title: item.title, changes });
      else plan.keptStarted.push({ key: item.key, title: cur.title, reason: "Already started, so it keeps its current version" });
    }
  // Only items that came from the previous template version are candidates for removal; items
  // staff added by hand stay.
  for (const cur of items) {
    if (cur.removed_at || nextKeys.has(cur.item_key) || !prevKeys.has(cur.item_key)) continue;
    if (cur.status === "not_started" && cur.doc_count === 0) plan.removed.push({ key: cur.item_key, title: cur.title });
    else plan.keptRemoved.push({ key: cur.item_key, title: cur.title, reason: "Removed from the template, but the client already started it" });
  }
  return plan;
}

/** Applies an upgrade plan. Only untouched requirements change; anything already started is preserved. */
export async function applyTemplateUpgrade(tx: Tx, onboardingId: string) {
  const plan = await planTemplateUpgrade(tx, onboardingId);
  if (!plan) throw new Error("This onboarding is already on the latest template version.");
  const onb = (await tx.one<{ workspace_id: string; client_id: string; owner_user_id: string | null; start_date: string }>(
    "select workspace_id, client_id, owner_user_id, start_date::text from onboardings where id = $1 for update",
    [onboardingId],
  ))!;
  const tv = (await tx.one<{ content: TemplateContent }>("select content from template_versions where id = $1", [plan.toVersionId]))!;
  const [{ pos }] = await tx.q<{ pos: number }>("select coalesce(max(position), 0) + 1 as pos from onboarding_items where onboarding_id = $1", [onboardingId]);
  let position = pos;
  const added = new Set(plan.added.map((a) => a.key));
  const updated = new Set(plan.updated.map((u) => u.key));
  for (const section of tv.content.sections)
    for (const item of section.items) {
      if (added.has(item.key)) {
        await tx.q("delete from onboarding_items where onboarding_id = $1 and item_key = $2 and removed_at is not null", [onboardingId, item.key]);
        await insertItem(tx, { workspaceId: onb.workspace_id, clientId: onb.client_id, onboardingId }, section, item, position++, onb.owner_user_id, onb.start_date, plan.toVersion);
      } else if (updated.has(item.key)) {
        const c = itemColumns(item, onb.owner_user_id, onb.start_date);
        await tx.q(
          `update onboarding_items set section_key = $3, section_title = $4, title = $5, description = $6, required = $7, due_at = $8,
             depends_on = $9, config = $10, weight = $11, critical = $12, review_required = $13, category = $14, source_version = $15, updated_at = now()
           where onboarding_id = $1 and item_key = $2`,
          [onboardingId, item.key, section.key, section.title, c.title, c.description, c.required, c.due_at?.toISOString() ?? null,
           c.depends_on, JSON.stringify(c.config), c.weight, c.critical, c.review_required, c.category, plan.toVersion],
        );
      }
    }
  if (plan.removed.length)
    await tx.q("update onboarding_items set removed_at = now() where onboarding_id = $1 and item_key = any($2)", [
      onboardingId,
      plan.removed.map((r) => r.key),
    ]);
  await tx.q("update onboardings set template_version = $2, template_version_id = $3, upgraded_at = now() where id = $1", [
    onboardingId,
    plan.toVersion,
    plan.toVersionId,
  ]);
  return plan;
}
