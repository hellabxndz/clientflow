import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { NewClientForm, type ClientTypeOption } from "./new-client-form";
import { COMMON_TIMEZONES } from "@/lib/time";

export const metadata = { title: "New client" };

export default async function NewClientPage() {
  const auth = await requireStaff();
  const { templates, staff, clientTypes } = await withTenant(tenantCtx(auth), async (tx) => ({
    templates: await tx.q<{ id: string; name: string; current_version: number }>(
      "select id, name, current_version from templates where archived = false and current_version > 0 order by name",
    ),
    staff: (await staffNames(tx)).list,
    clientTypes: await tx.q<ClientTypeOption>(
      "select id, name, description, template_id, default_owner_user_id from client_types order by position, name",
    ),
  }));
  const timezones = COMMON_TIMEZONES.includes(auth.workspace.timezone) ? COMMON_TIMEZONES : [auth.workspace.timezone, ...COMMON_TIMEZONES];
  return (
    <>
      <PageHeader
        title="New client"
        description="Create the client, start their onboarding from a template, and invite their main contact."
        actions={<Link href="/app/clients" className="btn-secondary">Cancel</Link>}
      />
      <NewClientForm
        templates={templates}
        staff={staff.map((s) => ({ id: s.id, name: s.name }))}
        clientTypes={clientTypes}
        defaultOwner={auth.user.id}
        timezones={timezones}
        defaultTimezone={auth.workspace.timezone}
        isDemo={auth.workspace.is_demo}
      />
    </>
  );
}
