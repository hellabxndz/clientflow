import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Card, EmptyState, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { deleteClientTypeAction, saveClientTypeAction } from "./actions";

export const metadata = { title: "Client types" };

interface TypeRow {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  template_name: string | null;
  template_version: number | null;
  default_owner_user_id: string | null;
  owner_name: string | null;
  position: number;
  clients: number;
}

function TypeForm({ row, templates, staff, nextPosition }: { row?: TypeRow; templates: { id: string; name: string; current_version: number }[]; staff: { id: string; name: string }[]; nextPosition: number }) {
  return (
    <ActionForm action={saveClientTypeAction} className="space-y-3" resetOnSuccess={!row}>
      {row && <input type="hidden" name="id" value={row.id} />}
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
        <div>
          <label className="label">Name</label>
          <input name="name" className="input" defaultValue={row?.name ?? ""} maxLength={80} placeholder="e.g. Paid Ads" required />
        </div>
        <div>
          <label className="label">Position</label>
          <input name="position" type="number" min={0} max={999} className="input" defaultValue={row?.position ?? nextPosition} />
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <textarea name="description" className="input min-h-[64px] text-sm" defaultValue={row?.description ?? ""} maxLength={400} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Workflow template</label>
          <select name="templateId" className="input" defaultValue={row?.template_id ?? ""}>
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.current_version === 0 ? " (draft, unpublished)" : ""}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Default owner</label>
          <select name="defaultOwnerUserId" className="input" defaultValue={row?.default_owner_user_id ?? ""}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>
      <SubmitButton pendingText="Saving…">{row ? "Save changes" : "Add client type"}</SubmitButton>
    </ActionForm>
  );
}

export default async function ClientTypesPage() {
  const auth = await requireStaff();
  const canEdit = can(auth.role, "manageClientTypes");
  const data = await withTenant(tenantCtx(auth), async (tx) => ({
    types: await tx.q<TypeRow>(
      `select ct.id, ct.name, ct.description, ct.template_id, t.name as template_name, t.current_version as template_version,
              ct.default_owner_user_id, u.name as owner_name, ct.position,
              (select count(*)::int from clients c where c.client_type_id = ct.id and c.archived_at is null) as clients
       from client_types ct left join templates t on t.id = ct.template_id left join users u on u.id = ct.default_owner_user_id
       order by ct.position, ct.name`,
    ),
    templates: await tx.q<{ id: string; name: string; current_version: number }>("select id, name, current_version from templates where not archived order by name"),
    staff: await tx.q<{ id: string; name: string }>("select u.id, u.name from memberships m join users u on u.id = m.user_id where m.role in ('admin', 'manager', 'staff') order by u.name"),
  }));
  const nextPosition = data.types.length ? Math.max(...data.types.map((t) => t.position)) + 1 : 0;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Notice title="How client types are used">
          Client types are your service lines. When a CRM deal is marked won, its service value (for example the HubSpot deal property you configured) is matched to a client type by name, and that type&apos;s workflow template and default owner are used to start onboarding automatically. Clients added manually or by CSV can pick a type too.
        </Notice>
        {!canEdit && <Notice>Only managers and admins can change client types.</Notice>}
        {data.types.length === 0 ? (
          <EmptyState title="No client types yet" description="Add one per service you sell, such as Paid Ads or SEO, and link it to a workflow template." />
        ) : (
          <Card title={`Client types (${data.types.length})`} padded={false}>
            <ul className="divide-y divide-ink-100">
              {data.types.map((t) => (
                <li key={t.id} className="px-5 py-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {t.name}
                        <span className="text-xs font-normal text-ink-400">#{t.position}</span>
                      </p>
                      {t.description && <p className="mt-0.5 text-sm text-ink-500">{t.description}</p>}
                      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                        {t.template_id ? (
                          <Link href={`/app/templates/${t.template_id}`} className="inline-flex">
                            <Badge tone={t.template_version ? "brand" : "warning"}>
                              {t.template_name}{t.template_version ? ` v${t.template_version}` : " (unpublished)"}
                            </Badge>
                          </Link>
                        ) : (
                          <Badge tone="warning">No template</Badge>
                        )}
                        <Badge>{t.owner_name ? `Owner: ${t.owner_name}` : "No default owner"}</Badge>
                        <Link href={`/app/clients?type=${t.id}`} className="inline-flex"><Badge tone="info">{t.clients} client{t.clients === 1 ? "" : "s"}</Badge></Link>
                      </div>
                    </div>
                  </div>
                  {canEdit && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-ink-600">Edit</summary>
                      <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/50 p-4">
                        <TypeForm row={t} templates={data.templates} staff={data.staff} nextPosition={nextPosition} />
                        <ActionForm action={deleteClientTypeAction} className="mt-3 border-t border-ink-100 pt-3" confirm={`Delete "${t.name}"? Clients of this type keep their onboardings.`}>
                          <input type="hidden" name="id" value={t.id} />
                          <SubmitButton className="btn-danger">Delete client type</SubmitButton>
                        </ActionForm>
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="space-y-6">
        {canEdit && (
          <Card title="New client type">
            <TypeForm templates={data.templates} staff={data.staff} nextPosition={nextPosition} />
          </Card>
        )}
      </div>
    </div>
  );
}
