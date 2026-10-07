import Link from "next/link";
import { notFound } from "next/navigation";
import { BellRing, Workflow } from "lucide-react";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames } from "@/lib/queries";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDate, formatDateTime } from "@/lib/time";
import type { TemplateContent } from "@/lib/templates";
import { TemplateEditor } from "./editor";
import { archiveTemplate, duplicateTemplate } from "../actions";
import { canEditTemplates } from "../permissions";

export const metadata = { title: "Edit template" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const t = await tx.one<{ id: string; name: string; description: string | null; category: string; draft: TemplateContent; current_version: number; archived: boolean }>(
      "select id, name, description, category, draft, current_version, archived from templates where id = $1",
      [id],
    );
    if (!t) return null;
    const versions = await tx.q<{ version: number; published_at: Date; change_note: string | null; publisher: string | null; active: number; total: number }>(
      `select v.version, v.published_at, v.change_note, u.name as publisher,
              (select count(*)::int from onboardings o where o.template_id = v.template_id and o.template_version = v.version and o.status in ('active', 'paused')) as active,
              (select count(*)::int from onboardings o where o.template_id = v.template_id and o.template_version = v.version) as total
       from template_versions v left join users u on u.id = v.published_by where v.template_id = $1 order by v.version desc`,
      [id],
    );
    const onboardings = await tx.q<{ client_id: string; client_name: string; template_version: number | null; status: string }>(
      `select o.client_id, c.name as client_name, o.template_version, o.status from onboardings o join clients c on c.id = o.client_id
       where o.template_id = $1 and o.status in ('active', 'paused') order by o.template_version desc nulls last, c.name`,
      [id],
    );
    const types = await tx.q<{ id: string; name: string }>("select id, name from client_types where template_id = $1 order by position, name", [id]);
    const rules = await tx.q<{ id: string; name: string; enabled: boolean }>("select id, name, enabled from automation_rules where template_id = $1 order by name", [id]);
    const reminders = await tx.q<{ id: string; name: string; enabled: boolean }>("select id, name, enabled from reminder_rules where template_id = $1 order by name", [id]);
    return { t, versions, onboardings, types, rules, reminders, staff: (await staffNames(tx)).list };
  });
  if (!data) notFound();
  const canEdit = canEditTemplates(auth);
  const latest = data.t.current_version;
  const behind = data.onboardings.filter((o) => o.template_version != null && o.template_version < latest).length;

  return (
    <>
      <div className="mb-2 text-sm"><Link href="/app/templates" className="text-ink-500 hover:text-ink-800">← Templates</Link></div>
      {!canEdit && <Notice className="mb-4">You can view this template. Only managers and admins can edit templates in this workspace.</Notice>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <TemplateEditor
            template={{ id: data.t.id, name: data.t.name, description: data.t.description ?? "", category: data.t.category, content: data.t.draft, currentVersion: data.t.current_version }}
            staff={data.staff.map((s) => ({ id: s.id, name: s.name }))}
            readOnly={!canEdit}
          />
        </div>
        <div className="min-w-0 space-y-6">
          <Card title="Versions" padded={false}>
            {data.versions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">Not published yet. Publish to use this template for onboardings.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.versions.map((v) => (
                  <li key={v.version} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">v{v.version}{v.version === latest && <Badge tone="brand" className="ml-2">Latest</Badge>}</span>
                      <span className="text-xs text-ink-500">{v.active} active · {v.total} total</span>
                    </div>
                    <p className="text-xs text-ink-500">Published {formatDate(v.published_at)} by {v.publisher ?? "Unknown"}</p>
                    {v.change_note && <p className="mt-1 text-xs text-ink-600">{v.change_note}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-ink-100 px-5 py-3 text-xs leading-relaxed text-ink-500">
              Published versions never change. Live onboardings keep the versioned copy they started with and only change through the explicit
              <span className="font-medium text-ink-700"> Upgrade template</span> action on the client's page.
            </p>
          </Card>

          <Card title="Active onboardings" padded={false} className="scroll-mt-20">
            <div id="onboardings" />
            {data.onboardings.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">No live onboardings use this template.</p>
            ) : (
              <>
                {behind > 0 && <p className="border-b border-ink-100 bg-amber-50 px-5 py-2.5 text-xs text-amber-900">{behind} on an older version. Upgrade from each client's page if they should get the changes.</p>}
                <ul className="max-h-72 divide-y divide-ink-100 overflow-y-auto">
                  {data.onboardings.map((o) => (
                    <li key={o.client_id + String(o.template_version)}>
                      <Link href={`/app/clients/${o.client_id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 text-sm hover:bg-ink-50">
                        <span className="min-w-0 truncate">{o.client_name}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {o.status === "paused" && <Badge>Paused</Badge>}
                          <Badge tone={o.template_version === latest ? "neutral" : "warning"}>v{o.template_version ?? "?"}</Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Used by">
            <div className="space-y-4 text-sm">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Client types</p>
                {data.types.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">{data.types.map((t) => <Badge key={t.id}>{t.name}</Badge>)}</div>
                ) : (
                  <p className="mt-1 text-ink-500">None. <Link href="/app/settings/client-types" className="link">Set a default template for a client type</Link></p>
                )}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Automations scoped to this template</p>
                {data.rules.length ? (
                  <ul className="mt-1 space-y-1">
                    {data.rules.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <Workflow className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                        <Link href={`/app/automations/${r.id}`} className="link min-w-0 truncate">{r.name}</Link>
                        {!r.enabled && <Badge>Off</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-500">None. Workspace-wide rules still apply. <Link href="/app/automations" className="link">Automations</Link></p>
                )}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Reminder rules scoped to this template</p>
                {data.reminders.length ? (
                  <ul className="mt-1 space-y-1">
                    {data.reminders.map((r) => (
                      <li key={r.id} className="flex items-center gap-2">
                        <BellRing className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                        <Link href="/app/settings/reminders" className="link min-w-0 truncate">{r.name}</Link>
                        {!r.enabled && <Badge>Off</Badge>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-ink-500">None. <Link href="/app/settings/reminders" className="link">Reminder rules</Link></p>
                )}
              </div>
            </div>
          </Card>

          {canEdit && (
            <Card title="More">
              <div className="flex flex-wrap gap-2">
                <form action={duplicateTemplate}>
                  <input type="hidden" name="templateId" value={data.t.id} />
                  <button className="btn-secondary">Duplicate</button>
                </form>
                <ActionForm action={archiveTemplate} showSuccess={false} confirm={data.t.archived ? undefined : "Archive this template? Live onboardings are not affected."}>
                  <input type="hidden" name="templateId" value={data.t.id} />
                  <input type="hidden" name="archived" value={data.t.archived ? "false" : "true"} />
                  <SubmitButton className="btn-secondary">{data.t.archived ? "Restore" : "Archive"}</SubmitButton>
                </ActionForm>
              </div>
              <p className="mt-3 text-xs text-ink-400">Last published {data.versions[0] ? formatDateTime(data.versions[0].published_at) : "never"}.</p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
