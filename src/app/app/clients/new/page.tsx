import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { staffNames } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { NewClientForm } from "./new-client-form";
import { COMMON_TIMEZONES } from "@/lib/time";

export const metadata = { title: "New client" };

export default async function NewClientPage() {
  const auth = await requireStaff();
  const { templates, staff } = await withTenant(tenantCtx(auth), async (tx) => ({
    templates: await tx.q<{ id: string; name: string; current_version: number }>(
      "select id, name, current_version from templates where archived = false and current_version > 0 order by name",
    ),
    staff: (await staffNames(tx)).list,
  }));
  return (
    <>
      <PageHeader title="New client" description="Create the client, start their onboarding from a template, and invite their main contact." />
      <NewClientForm
        templates={templates}
        staff={staff.map((s) => ({ id: s.id, name: s.name }))}
        defaultOwner={auth.user.id}
        timezones={COMMON_TIMEZONES}
        defaultTimezone={auth.workspace.timezone}
        isDemo={auth.workspace.is_demo}
      />
    </>
  );
}
