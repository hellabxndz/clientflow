import Link from "next/link";
import { BookCopy, FilePlus2, Workflow, BellRing, Users } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/time";
import { ACCOUNTING_TEMPLATE, AGENCY_WORKFLOWS } from "@/lib/template-library";
import { createFromLibraryAction } from "./actions";
import { canEditTemplates } from "./permissions";

export const metadata = { title: "Templates" };

type Row = {
  id: string; name: string; description: string | null; category: string; current_version: number; archived: boolean; updated_at: Date;
  item_count: number; has_unpublished: boolean; published_at: Date | null;
};

function itemCount(content: { sections: { items: unknown[] }[] }) {
  return content.sections.reduce((n, s) => n + s.items.length, 0);
}

export default async function TemplatesPage() {
  const auth = await requireStaff();
  const canEdit = canEditTemplates(auth);
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const templates = await tx.q<Row>(
      `select t.id, t.name, t.description, t.category, t.current_version, t.archived, t.updated_at,
              (select coalesce(sum(jsonb_array_length(s->'items')), 0)::int from jsonb_array_elements(t.draft->'sections') s) as item_count,
              coalesce((select v.content from template_versions v where v.template_id = t.id order by v.version desc limit 1) is distinct from t.draft, true) as has_unpublished,
              (select v.published_at from template_versions v where v.template_id = t.id order by v.version desc limit 1) as published_at
       from templates t order by t.archived, t.name`,
    );
    const perVersion = await tx.q<{ template_id: string; template_version: number | null; n: number }>(
      `select template_id, template_version, count(*)::int as n from onboardings
       where template_id is not null and status in ('active', 'paused') group by template_id, template_version order by template_version desc`,
    );
    const types = await tx.q<{ template_id: string; name: string }>("select template_id, name from client_types where template_id is not null order by position, name");
    const rules = await tx.q<{ template_id: string; n: number }>("select template_id, count(*)::int as n from automation_rules where template_id is not null group by template_id");
    const reminders = await tx.q<{ template_id: string; n: number }>("select template_id, count(*)::int as n from reminder_rules where template_id is not null group by template_id");
    return { templates, perVersion, types, rules, reminders };
  });

  const versionsOf = (id: string) => data.perVersion.filter((v) => v.template_id === id);
  const typesOf = (id: string) => data.types.filter((t) => t.template_id === id).map((t) => t.name);
  const rulesOf = (id: string) => data.rules.find((r) => r.template_id === id)?.n ?? 0;
  const remindersOf = (id: string) => data.reminders.find((r) => r.template_id === id)?.n ?? 0;

  return (
    <>
      <PageHeader
        title="Templates"
        description="Onboarding workflows for each kind of client. Every new onboarding gets a copy of the latest published version."
      />
      <Notice className="mb-6">
        Live onboardings keep the versioned copy they started with. Publishing a new version never changes them; to move a client onto it, use
        <span className="font-medium"> Upgrade template</span> on that client's page.
      </Notice>
      {!canEdit && <Notice tone="warning" className="mb-6">Only managers and admins can create or edit templates in this workspace.</Notice>}

      {data.templates.length === 0 ? (
        <EmptyState title="No templates yet" description="Start from one of the library workflows below." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.templates.map((t) => {
            const versions = versionsOf(t.id);
            const active = versions.reduce((n, v) => n + v.n, 0);
            const types = typesOf(t.id);
            const nRules = rulesOf(t.id);
            const nReminders = remindersOf(t.id);
            return (
              <div key={t.id} className={`card flex flex-col p-5 transition hover:border-brand-200 hover:shadow-md ${t.archived ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/app/templates/${t.id}`} className="min-w-0 font-semibold text-ink-900 hover:text-brand-700">{t.name}</Link>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {t.archived && <Badge>Archived</Badge>}
                    {t.current_version === 0 ? <Badge tone="warning">Unpublished</Badge> : <Badge tone="brand">v{t.current_version}</Badge>}
                    {t.current_version > 0 && t.has_unpublished && <Badge tone="info">Draft changes</Badge>}
                  </div>
                </div>
                {t.description && <p className="mt-1 line-clamp-2 text-sm text-ink-500">{t.description}</p>}
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Published</dt>
                    <dd className="mt-0.5 text-ink-800">{t.published_at ? formatDate(t.published_at) : "Not yet"}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Items</dt>
                    <dd className="mt-0.5 text-ink-800">{t.item_count}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Active onboardings</dt>
                    <dd className="mt-0.5 text-ink-800">
                      {active === 0 ? (
                        <span className="text-ink-500">None</span>
                      ) : (
                        <Link href={`/app/templates/${t.id}#onboardings`} className="link">
                          {active} · {versions.map((v) => `v${v.template_version ?? "?"}: ${v.n}`).join(", ")}
                        </Link>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-ink-100 pt-3 text-xs text-ink-500">
                  <span className="inline-flex min-w-0 items-center gap-1"><Users className="h-3.5 w-3.5 shrink-0" />{types.length ? <span className="truncate">{types.join(", ")}</span> : "No client types"}</span>
                  <Link href="/app/automations" className="inline-flex items-center gap-1 hover:text-ink-800"><Workflow className="h-3.5 w-3.5" />{nRules} automation{nRules === 1 ? "" : "s"}</Link>
                  <Link href="/app/settings/reminders" className="inline-flex items-center gap-1 hover:text-ink-800"><BellRing className="h-3.5 w-3.5" />{nReminders} reminder rule{nReminders === 1 ? "" : "s"}</Link>
                  <span className="ml-auto">Updated {formatDate(t.updated_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <Card title={<span className="inline-flex items-center gap-2"><BookCopy className="h-4 w-4 text-ink-400" /> Create from library</span>} className="mt-8">
          <p className="mb-4 text-sm text-ink-500">Each creates an editable draft. Nothing reaches clients until you publish it.</p>
          <form action={createFromLibraryAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AGENCY_WORKFLOWS.map((w, i) => (
              <button key={w.name} name="source" value={`workflow:${i}`} className="rounded-lg border border-ink-200 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
                <p className="font-medium text-ink-900">{w.name}</p>
                <p className="mt-1 line-clamp-3 text-sm text-ink-500">{w.description}</p>
                <p className="mt-2 text-xs text-ink-400">{itemCount(w.content)} items</p>
              </button>
            ))}
            <button name="source" value="accounting" className="rounded-lg border border-ink-200 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
              <p className="font-medium text-ink-900">{ACCOUNTING_TEMPLATE.name}</p>
              <p className="mt-1 line-clamp-3 text-sm text-ink-500">{ACCOUNTING_TEMPLATE.description}</p>
              <p className="mt-2 text-xs text-ink-400">{itemCount(ACCOUNTING_TEMPLATE.content)} items</p>
            </button>
            <button name="source" value="blank" className="rounded-lg border border-dashed border-ink-300 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
              <p className="inline-flex items-center gap-1.5 font-medium text-ink-900"><FilePlus2 className="h-4 w-4" /> Blank</p>
              <p className="mt-1 text-sm text-ink-500">Start from one section and build your own.</p>
            </button>
          </form>
        </Card>
      )}
    </>
  );
}
