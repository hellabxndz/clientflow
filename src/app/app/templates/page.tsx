import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/time";
import { createTemplateAction } from "../actions";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const auth = await requireStaff();
  const canEdit = auth.workspace.template_edit_role === "staff" || auth.role === "admin";
  const templates = await withTenant(tenantCtx(auth), (tx) =>
    tx.q<{ id: string; name: string; description: string | null; category: string; current_version: number; archived: boolean; updated_at: Date; active_onboardings: number; item_count: number; has_unpublished: boolean }>(
      `select t.id, t.name, t.description, t.category, t.current_version, t.archived, t.updated_at,
              (select count(*)::int from onboardings o where o.template_id = t.id and o.status in ('active','paused')) as active_onboardings,
              (select coalesce(sum(jsonb_array_length(s->'items')), 0)::int from jsonb_array_elements(t.draft->'sections') s) as item_count,
              coalesce((select v.content from template_versions v where v.template_id = t.id order by v.version desc limit 1) is distinct from t.draft, true) as has_unpublished
       from templates t order by t.archived, t.name`,
    ),
  );
  return (
    <>
      <PageHeader title="Templates" description="Reusable onboarding checklists. Each new onboarding gets a copy of the latest published version." />
      {!canEdit && <Notice className="mb-6">Only admins can create or edit templates in this workspace.</Notice>}
      {canEdit && (
        <Card title="Create a template" className="mb-6">
          <form action={createTemplateAction} className="grid gap-3 sm:grid-cols-3">
            <button name="source" value="agency" className="rounded-lg border border-ink-200 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
              <p className="font-medium">Marketing agency</p>
              <p className="mt-1 text-sm text-ink-500">Business details, goals, brand assets, contacts, scope, account access, kickoff.</p>
            </button>
            <button name="source" value="accounting" className="rounded-lg border border-ink-200 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
              <p className="font-medium">Accounting firm</p>
              <p className="mt-1 text-sm text-ink-500">Engagement letter, entity details, records and bookkeeping access.</p>
            </button>
            <button name="source" value="blank" className="rounded-lg border border-dashed border-ink-300 p-4 text-left transition hover:border-brand-300 hover:bg-brand-50/40">
              <p className="font-medium">Blank</p>
              <p className="mt-1 text-sm text-ink-500">Start from one section and build your own.</p>
            </button>
          </form>
        </Card>
      )}
      {templates.length === 0 ? (
        <EmptyState title="No templates yet" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((t) => (
            <Link key={t.id} href={`/app/templates/${t.id}`} className={`card block p-5 transition hover:border-brand-200 hover:shadow-md ${t.archived ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-semibold">{t.name}</p>
                <div className="flex shrink-0 gap-1">
                  {t.archived && <Badge>Archived</Badge>}
                  {t.current_version === 0 ? <Badge tone="warning">Unpublished</Badge> : <Badge tone="brand">v{t.current_version}</Badge>}
                  {t.current_version > 0 && t.has_unpublished && <Badge tone="info">Draft changes</Badge>}
                </div>
              </div>
              {t.description && <p className="mt-1 line-clamp-2 text-sm text-ink-500">{t.description}</p>}
              <p className="mt-3 text-xs text-ink-500">
                {t.item_count} items · {t.active_onboardings} active onboarding{t.active_onboardings === 1 ? "" : "s"} · updated {formatDate(t.updated_at)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
