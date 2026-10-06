import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames } from "@/lib/queries";
import { Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import type { TemplateContent } from "@/lib/templates";
import { TemplateEditor } from "./editor";
import { archiveTemplateAction, duplicateTemplateAction } from "../../actions";

export const metadata = { title: "Edit template" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStaff();
  const { id } = await params;
  const data = await withTenant(tenantCtx(auth), async (tx) => {
    const t = await tx.one<{ id: string; name: string; description: string | null; category: string; draft: TemplateContent; current_version: number; archived: boolean }>(
      "select * from templates where id = $1",
      [id],
    );
    if (!t) return null;
    const versions = await tx.q<{ version: number; published_at: Date; change_note: string | null; publisher: string | null; onboardings: number }>(
      `select v.version, v.published_at, v.change_note, u.name as publisher,
              (select count(*)::int from onboardings o where o.template_version_id = v.id) as onboardings
       from template_versions v left join users u on u.id = v.published_by where v.template_id = $1 order by v.version desc`,
      [id],
    );
    return { t, versions, staff: (await staffNames(tx)).list };
  });
  if (!data) notFound();
  const canEdit = auth.workspace.template_edit_role === "staff" || auth.role === "admin";
  return (
    <>
      <div className="mb-2 text-sm"><Link href="/app/templates" className="text-ink-500 hover:text-ink-800">← Templates</Link></div>
      {!canEdit && <Notice className="mb-4">You can view this template. Only admins can edit templates in this workspace.</Notice>}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <TemplateEditor
          template={{ id: data.t.id, name: data.t.name, description: data.t.description ?? "", category: data.t.category, content: data.t.draft, currentVersion: data.t.current_version }}
          staff={data.staff.map((s) => ({ id: s.id, name: s.name }))}
          readOnly={!canEdit}
        />
        <div className="space-y-6">
          <Card title="Versions" padded={false}>
            {data.versions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-500">Not published yet. Publish to use this template for onboardings.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.versions.map((v) => (
                  <li key={v.version} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">v{v.version}</span>
                      <span className="text-xs text-ink-500">{v.onboardings} onboarding{v.onboardings === 1 ? "" : "s"}</span>
                    </div>
                    <p className="text-xs text-ink-500">{v.publisher ?? "Unknown"} · {formatDateTime(v.published_at)}</p>
                    {v.change_note && <p className="mt-1 text-xs text-ink-600">{v.change_note}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="border-t border-ink-100 px-5 py-3 text-xs text-ink-500">Published versions never change. Onboardings keep the version they started with.</p>
          </Card>
          {canEdit && (
            <Card title="More">
              <div className="flex flex-wrap gap-2">
                <form action={duplicateTemplateAction}>
                  <input type="hidden" name="templateId" value={data.t.id} />
                  <button className="btn-secondary">Duplicate</button>
                </form>
                <ActionForm action={archiveTemplateAction} showSuccess={false}>
                  <input type="hidden" name="templateId" value={data.t.id} />
                  <input type="hidden" name="archived" value={data.t.archived ? "false" : "true"} />
                  <SubmitButton className="btn-secondary">{data.t.archived ? "Restore" : "Archive"}</SubmitButton>
                </ActionForm>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
