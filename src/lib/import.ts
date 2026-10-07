import type { TenantContext, Tx } from "./db";
import { audit } from "./audit";
import { createOnboardingFromTemplate } from "./templates";
import { isValidTimeZone } from "./time";

export const IMPORT_KINDS = ["clients", "contacts", "onboardings", "tasks", "requirements"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  synonyms: string[];
  help?: string;
}

export const IMPORT_LABEL: Record<ImportKind, string> = {
  clients: "Clients",
  contacts: "Contacts",
  onboardings: "Active and past onboardings",
  tasks: "Internal tasks",
  requirements: "Client requirements",
};

const clientRef: ImportField = { key: "client", label: "Client name", required: true, synonyms: ["client", "client name", "company", "company name", "account", "account name", "customer", "business"] };

export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  clients: [
    { key: "name", label: "Client name", required: true, synonyms: ["name", "client", "client name", "company", "company name", "account", "account name", "business name", "customer"] },
    { key: "industry", label: "Industry", synonyms: ["industry", "vertical", "sector"] },
    { key: "website", label: "Website", synonyms: ["website", "url", "domain", "site", "web"] },
    { key: "timezone", label: "Time zone", synonyms: ["timezone", "time zone", "tz"], help: "IANA name, e.g. America/Chicago" },
    { key: "contact_name", label: "Primary contact name", synonyms: ["contact", "contact name", "primary contact", "point of contact", "poc"] },
    { key: "contact_email", label: "Primary contact email", synonyms: ["email", "contact email", "primary email", "primary contact email"] },
    { key: "account_manager", label: "Account manager email", synonyms: ["account manager", "owner", "am", "account manager email", "owner email", "csm"] },
    { key: "client_type", label: "Client type / service", synonyms: ["client type", "service", "services", "package", "plan", "type"] },
    { key: "deal_amount", label: "Contract value", synonyms: ["deal value", "contract value", "amount", "value", "mrr", "retainer", "monthly fee"] },
    { key: "deal_recurrence", label: "Value period", synonyms: ["billing", "recurrence", "period", "billing period"], help: "one_time, monthly or annual" },
  ],
  contacts: [
    clientRef,
    { key: "name", label: "Contact name", required: true, synonyms: ["name", "contact", "contact name", "full name", "person"] },
    { key: "email", label: "Email", synonyms: ["email", "email address", "e-mail"] },
    { key: "title", label: "Job title", synonyms: ["title", "job title", "position"] },
    { key: "role", label: "Contact role", synonyms: ["role", "contact role", "type"], help: "primary, billing, marketing, approver or other" },
    { key: "phone", label: "Phone", synonyms: ["phone", "phone number", "mobile", "tel"] },
  ],
  onboardings: [
    clientRef,
    { key: "template", label: "Workflow / template", required: true, synonyms: ["template", "workflow", "onboarding", "service", "package"] },
    { key: "start_date", label: "Start date", synonyms: ["start", "start date", "started", "kickoff start", "signed", "signed date", "close date"] },
    { key: "target_date", label: "Target date", synonyms: ["target", "target date", "go live", "launch date"] },
    { key: "owner", label: "Owner email", synonyms: ["owner", "account manager", "am", "owner email", "assigned to"] },
    { key: "status", label: "Status", synonyms: ["status", "stage", "state"], help: "active, paused or completed" },
    { key: "completed_date", label: "Completed date", synonyms: ["completed", "completed date", "finished", "end date", "kickoff date"] },
  ],
  tasks: [
    clientRef,
    { key: "title", label: "Task", required: true, synonyms: ["task", "title", "name", "to do", "todo", "action"] },
    { key: "owner", label: "Owner email", synonyms: ["owner", "assignee", "assigned to", "owner email"] },
    { key: "due_date", label: "Due date", synonyms: ["due", "due date", "deadline"] },
    { key: "status", label: "Status", synonyms: ["status", "state", "done"], help: "to do, in progress or done" },
  ],
  requirements: [
    clientRef,
    { key: "title", label: "Requirement", required: true, synonyms: ["requirement", "item", "title", "request", "document", "what we need"] },
    { key: "kind", label: "Type", synonyms: ["type", "kind", "request type"], help: "question, file or checklist (default: question)" },
    { key: "description", label: "Instructions", synonyms: ["description", "instructions", "notes", "details"] },
    { key: "due_date", label: "Due date", synonyms: ["due", "due date", "deadline"] },
    { key: "status", label: "Status", synonyms: ["status", "state", "received"], help: "outstanding or received" },
    { key: "required", label: "Required", synonyms: ["required", "mandatory", "optional"], help: "yes or no (default yes)" },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Guesses a column for each field from the CSV header. */
export function guessMapping(kind: ImportKind, header: string[]) {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS[kind]) {
    const idx = header.findIndex((h, i) => !used.has(i) && (norm(h) === norm(field.key) || field.synonyms.includes(norm(h))));
    if (idx >= 0) {
      mapping[field.key] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

export function parseDate(v: string): string | null | "invalid" {
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
  if (m) return fmt(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  return "invalid";
}

function fmt(y: number, mo: number, d: number) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return "invalid" as const;
  return date.toISOString().slice(0, 10);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domainOf = (w: string) => w.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
const truthy = (v: string) => !/^(no|n|false|0|optional)$/i.test(v.trim());

export interface RowResult {
  row: number;
  values: Record<string, string>;
  errors: string[];
  warnings: string[];
  duplicate: "existing" | "in_file" | null;
  action: "create" | "skip";
}

interface Lookups {
  clients: { id: string; name: string; website: string | null; primary_contact_email: string | null }[];
  staff: { id: string; email: string }[];
  templates: { id: string; name: string; current_version: number }[];
  clientTypes: { id: string; name: string }[];
  contacts: { client_id: string; email: string | null }[];
  activeOnboardings: { client_id: string }[];
}

async function lookups(tx: Tx): Promise<Lookups> {
  return {
    clients: await tx.q("select id, name, website, primary_contact_email from clients where archived_at is null"),
    staff: await tx.q("select u.id, u.email from memberships m join users u on u.id = m.user_id where m.role <> 'client'"),
    templates: await tx.q("select id, name, current_version from templates where not archived"),
    clientTypes: await tx.q("select id, name from client_types"),
    contacts: await tx.q("select client_id, email from client_contacts"),
    activeOnboardings: await tx.q("select client_id from onboardings where status in ('active', 'paused')"),
  };
}

/** Validates every row and flags duplicates against existing records and earlier rows in the file. Writes nothing. */
export async function validateImport(tx: Tx, kind: ImportKind, rows: string[][], mapping: Record<string, number>) {
  const L = await lookups(tx);
  const fields = IMPORT_FIELDS[kind];
  const missingRequired = fields.filter((f) => f.required && mapping[f.key] === undefined).map((f) => f.label);
  const seen = new Set<string>();
  const findClient = (name: string) => L.clients.find((c) => norm(c.name) === norm(name));
  const results: RowResult[] = rows.map((r, i) => {
    const values: Record<string, string> = {};
    for (const f of fields) values[f.key] = mapping[f.key] !== undefined ? (r[mapping[f.key]] ?? "").trim() : "";
    const errors: string[] = [];
    const warnings: string[] = [];
    let duplicate: RowResult["duplicate"] = null;
    for (const f of fields) if (f.required && !values[f.key]) errors.push(`${f.label} is missing`);
    const checkDate = (k: string, label: string) => {
      if (parseDate(values[k] ?? "") === "invalid") errors.push(`${label} "${values[k]}" isn't a date (use YYYY-MM-DD or MM/DD/YYYY)`);
    };
    const checkStaff = (k: string) => {
      if (values[k] && !L.staff.some((s) => s.email.toLowerCase() === values[k].toLowerCase()))
        warnings.push(`${values[k]} isn't on the team; it will be left unassigned`);
    };
    if (kind === "clients") {
      const key = norm(values.name);
      const domain = values.website ? domainOf(values.website) : "";
      const existing = L.clients.find(
        (c) =>
          norm(c.name) === key ||
          (domain && c.website && domainOf(c.website) === domain) ||
          (values.contact_email && c.primary_contact_email?.toLowerCase() === values.contact_email.toLowerCase()),
      );
      if (existing) duplicate = "existing";
      else if (key && seen.has(key)) duplicate = "in_file";
      if (key) seen.add(key);
      if (domain) seen.add(`d:${domain}`);
      if (values.contact_email && !EMAIL.test(values.contact_email)) errors.push(`"${values.contact_email}" isn't a valid email`);
      if (values.timezone && !isValidTimeZone(values.timezone)) errors.push(`Unknown time zone "${values.timezone}"`);
      if (values.deal_amount && Number.isNaN(Number(values.deal_amount.replace(/[$,\s]/g, "")))) errors.push(`Contract value "${values.deal_amount}" isn't a number`);
      if (values.deal_recurrence && !/^(one[_ -]?time|monthly|annual|yearly)$/i.test(values.deal_recurrence)) errors.push("Value period must be one_time, monthly or annual");
      if (values.client_type && !L.clientTypes.some((t) => norm(t.name) === norm(values.client_type)))
        warnings.push(`Client type "${values.client_type}" doesn't exist; it will be left blank`);
      checkStaff("account_manager");
    } else {
      const client = values.client ? findClient(values.client) : undefined;
      if (values.client && !client) errors.push(`No client named "${values.client}". Import clients first.`);
      if (kind === "contacts") {
        if (values.email && !EMAIL.test(values.email)) errors.push(`"${values.email}" isn't a valid email`);
        const k = `${norm(values.client)}|${values.email.toLowerCase() || norm(values.name)}`;
        if (client && values.email && L.contacts.some((c) => c.client_id === client.id && c.email?.toLowerCase() === values.email.toLowerCase())) duplicate = "existing";
        else if (seen.has(k)) duplicate = "in_file";
        seen.add(k);
        if (values.role && !/^(primary|billing|marketing|approver|other)$/i.test(values.role)) warnings.push(`Role "${values.role}" will be saved as "other"`);
      }
      if (kind === "onboardings") {
        const status = (values.status || "active").toLowerCase();
        if (!["active", "paused", "completed"].includes(status)) errors.push("Status must be active, paused or completed");
        const tpl = L.templates.find((t) => norm(t.name) === norm(values.template));
        if (values.template && !tpl) errors.push(`No template named "${values.template}"`);
        else if (tpl && tpl.current_version === 0 && status !== "completed") errors.push(`Template "${tpl.name}" isn't published yet`);
        checkDate("start_date", "Start date");
        checkDate("target_date", "Target date");
        checkDate("completed_date", "Completed date");
        if (status === "completed" && !values.completed_date) errors.push("Completed onboardings need a completed date");
        if (status === "completed" && !values.start_date) errors.push("Completed onboardings need a start date");
        if (client && status !== "completed" && L.activeOnboardings.some((o) => o.client_id === client.id)) duplicate = "existing";
        const k = `${norm(values.client)}|${status}`;
        if (status !== "completed" && seen.has(k)) duplicate = "in_file";
        seen.add(k);
        checkStaff("owner");
      }
      if (kind === "tasks" || kind === "requirements") {
        if (client && !L.activeOnboardings.some((o) => o.client_id === client.id)) errors.push(`"${client.name}" has no active onboarding to add this to`);
        checkDate("due_date", "Due date");
        const k = `${norm(values.client)}|${norm(values.title)}`;
        if (seen.has(k)) duplicate = "in_file";
        seen.add(k);
        if (kind === "tasks") checkStaff("owner");
        if (kind === "requirements" && values.kind && !/^(question|file|checklist)$/i.test(values.kind)) errors.push("Type must be question, file or checklist");
      }
    }
    return { row: i + 2, values, errors, warnings, duplicate, action: errors.length || duplicate ? "skip" : "create" } satisfies RowResult;
  });
  return { results, missingRequired };
}

export interface ImportSummary {
  created: number;
  skippedDuplicates: number;
  failed: number;
  errors: { row: number; message: string }[];
}

/** Imports valid, non-duplicate rows. Each row runs in its own savepoint so one bad row can't break the rest. */
export async function executeImport(tx: Tx, ctx: TenantContext, kind: ImportKind, rows: string[][], mapping: Record<string, number>): Promise<ImportSummary> {
  const { results, missingRequired } = await validateImport(tx, kind, rows, mapping);
  if (missingRequired.length) throw new Error(`Map these required columns first: ${missingRequired.join(", ")}`);
  const L = await lookups(tx);
  const summary: ImportSummary = { created: 0, skippedDuplicates: 0, failed: 0, errors: [] };
  const staffId = (email: string) => (email ? L.staff.find((s) => s.email.toLowerCase() === email.toLowerCase())?.id ?? null : null);
  const clientId = (name: string) => L.clients.find((c) => norm(c.name) === norm(name))?.id ?? null;
  for (const r of results) {
    if (r.duplicate) {
      summary.skippedDuplicates++;
      continue;
    }
    if (r.errors.length) {
      summary.failed++;
      summary.errors.push({ row: r.row, message: r.errors.join("; ") });
      continue;
    }
    const v = r.values;
    await tx.q("savepoint import_row");
    try {
      if (kind === "clients") {
        const type = L.clientTypes.find((t) => norm(t.name) === norm(v.client_type));
        const rec = /^month/i.test(v.deal_recurrence) ? "monthly" : /^(annual|year)/i.test(v.deal_recurrence) ? "annual" : "one_time";
        const row = await tx.one<{ id: string }>(
          `insert into clients (workspace_id, name, industry, website, timezone, primary_contact_name, primary_contact_email, owner_user_id,
             client_type_id, deal_amount, deal_recurrence, source)
           values ($1,$2,$3,$4,coalesce(nullif($5, ''), (select timezone from workspaces where id = $1)),$6,$7,$8,$9,$10,$11,'csv') returning id`,
          [ctx.workspaceId, v.name, v.industry || null, v.website || null, v.timezone, v.contact_name || null, v.contact_email || null,
           staffId(v.account_manager), type?.id ?? null, v.deal_amount ? Number(v.deal_amount.replace(/[$,\s]/g, "")) : null, rec],
        );
        L.clients.push({ id: row!.id, name: v.name, website: v.website || null, primary_contact_email: v.contact_email || null });
        if (v.contact_name || v.contact_email)
          await tx.q(
            "insert into client_contacts (workspace_id, client_id, name, email, contact_role) values ($1,$2,$3,$4,'primary') on conflict do nothing",
            [ctx.workspaceId, row!.id, v.contact_name || v.contact_email, v.contact_email || null],
          );
      } else if (kind === "contacts") {
        const role = /^(primary|billing|marketing|approver)$/i.test(v.role) ? v.role.toLowerCase() : "other";
        await tx.q(
          "insert into client_contacts (workspace_id, client_id, name, email, title, contact_role, phone) values ($1,$2,$3,$4,$5,$6,$7)",
          [ctx.workspaceId, clientId(v.client), v.name, v.email || null, v.title || null, role, v.phone || null],
        );
      } else if (kind === "onboardings") {
        const cid = clientId(v.client)!;
        const tpl = L.templates.find((t) => norm(t.name) === norm(v.template))!;
        const status = (v.status || "active").toLowerCase();
        const start = parseDate(v.start_date) as string | null;
        if (status === "completed") {
          // Historical record: kept for reporting (durations, before/after comparisons). No requirements are copied.
          await tx.q(
            `insert into onboardings (workspace_id, client_id, template_id, template_name, name, status, start_date, completed_at, owner_user_id, source, created_at)
             values ($1,$2,$3,$4,$4,'completed',$5,$6::date + time '17:00',$7,'import',$5::date + time '09:00')`,
            [ctx.workspaceId, cid, tpl.id, tpl.name, start, parseDate(v.completed_date), staffId(v.owner)],
          );
        } else {
          const { onboardingId } = await createOnboardingFromTemplate(tx, {
            workspaceId: ctx.workspaceId,
            clientId: cid,
            templateId: tpl.id,
            ownerUserId: staffId(v.owner),
            startDate: start ? new Date(`${start}T12:00:00Z`) : undefined,
            targetDate: v.target_date ? new Date(`${parseDate(v.target_date)}T12:00:00Z`) : null,
            source: "import",
          });
          if (status === "paused") await tx.q("update onboardings set status = 'paused', paused_at = now() where id = $1", [onboardingId]);
          L.activeOnboardings.push({ client_id: cid });
        }
      } else {
        const cid = clientId(v.client)!;
        const onb = await tx.one<{ id: string; owner_user_id: string | null }>(
          "select id, owner_user_id from onboardings where client_id = $1 and status in ('active', 'paused') order by created_at desc limit 1",
          [cid],
        );
        const [{ pos }] = await tx.q<{ pos: number }>("select coalesce(max(position), 0) + 1 as pos from onboarding_items where onboarding_id = $1", [onb!.id]);
        const due = parseDate(v.due_date);
        const key = `imp_${Date.now().toString(36)}_${r.row}`;
        if (kind === "tasks") {
          const status = /done|complete|yes|true/i.test(v.status) ? "approved" : /progress|doing/i.test(v.status) ? "in_progress" : "not_started";
          await tx.q(
            `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key, position, kind, title,
               audience, required, due_at, owner_user_id, status)
             values ($1,$2,$3,'imported_tasks','Imported tasks',$4,$5,'task',$6,'internal',false,$7,$8,$9)`,
            [ctx.workspaceId, cid, onb!.id, key, pos, v.title.slice(0, 200), due ? `${due}T17:00:00Z` : null, staffId(v.owner) ?? onb!.owner_user_id, status],
          );
        } else {
          const itemKind = (v.kind || "question").toLowerCase();
          const received = /received|done|complete|yes|approved/i.test(v.status);
          const config =
            itemKind === "file"
              ? { file: { accept: ["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "csv", "zip"], maxSizeMb: 25 } }
              : itemKind === "checklist"
                ? { checklist: [{ key: "done", label: v.title.slice(0, 200) }] }
                : {};
          await tx.q(
            `insert into onboarding_items (workspace_id, client_id, onboarding_id, section_key, section_title, item_key, position, kind, title,
               description, audience, required, due_at, owner_user_id, status, config)
             values ($1,$2,$3,'imported','Imported requirements',$4,$5,$6,$7,$8,'client',$9,$10,$11,$12,$13)`,
            [ctx.workspaceId, cid, onb!.id, key, pos, itemKind, v.title.slice(0, 200), v.description || null, v.required ? truthy(v.required) : true,
             due ? `${due}T17:00:00Z` : null, onb!.owner_user_id, received ? "approved" : "not_started", JSON.stringify(config)],
          );
        }
      }
      await tx.q("release savepoint import_row");
      summary.created++;
    } catch (e) {
      await tx.q("rollback to savepoint import_row");
      summary.failed++;
      summary.errors.push({ row: r.row, message: e instanceof Error ? e.message : String(e) });
    }
  }
  await audit(tx, ctx, "import.completed", null, null, `Imported ${summary.created} ${IMPORT_LABEL[kind].toLowerCase()} (${summary.skippedDuplicates} duplicates skipped, ${summary.failed} failed)`);
  return summary;
}
