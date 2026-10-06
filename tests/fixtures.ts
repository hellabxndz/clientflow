import { withSysTx } from "../src/lib/db";
import { createOnboardingFromTemplate, publishTemplate } from "../src/lib/templates";
import { AGENCY_TEMPLATE } from "../src/lib/template-library";
import type { TenantContext } from "../src/lib/db";

let counter = 0;

export interface Fixture {
  workspaceId: string;
  adminId: string;
  staffId: string;
  templateId: string;
  clientA: { id: string; contactId: string; onboardingId: string };
  clientB: { id: string; contactId: string; onboardingId: string };
  ctx: {
    admin: TenantContext;
    staff: TenantContext;
    clientA: TenantContext;
    clientB: TenantContext;
  };
}

export async function makeWorkspace(opts: { isDemo?: boolean; timezone?: string } = {}): Promise<Fixture> {
  const n = ++counter + "-" + Math.random().toString(36).slice(2, 7);
  return withSysTx(async (tx) => {
    const user = async (label: string) =>
      (await tx.one<{ id: string }>("insert into users (email, name, password_hash) values ($1, $2, null) returning id", [`${label}-${n}@test.example.com`, label]))!.id;
    const ws = (await tx.one<{ id: string }>(
      "insert into workspaces (name, slug, is_demo) values ($1, $2, $3) returning id",
      [`WS ${n}`, `ws-${n}`, opts.isDemo ?? true],
    ))!.id;
    const adminId = await user("admin");
    const staffId = await user("staff");
    await tx.q("insert into memberships (workspace_id, user_id, role, can_approve) values ($1,$2,'admin',true),($1,$3,'staff',false)", [ws, adminId, staffId]);
    const tpl = (await tx.one<{ id: string }>(
      "insert into templates (workspace_id, name, draft) values ($1, 'Agency', $2) returning id",
      [ws, JSON.stringify(AGENCY_TEMPLATE.content)],
    ))!.id;
    await publishTemplate(tx, tpl, adminId);
    const mkClient = async (label: string) => {
      const id = (await tx.one<{ id: string }>(
        "insert into clients (workspace_id, name, timezone, primary_contact_email) values ($1, $2, $3, $4) returning id",
        [ws, `Client ${label}`, opts.timezone ?? "America/New_York", `${label}-contact-${n}@test.example.com`],
      ))!.id;
      const contactId = await user(`${label}-contact`);
      await tx.q("insert into memberships (workspace_id, user_id, role, client_id) values ($1,$2,'client',$3)", [ws, contactId, id]);
      const { onboardingId } = await createOnboardingFromTemplate(tx, { workspaceId: ws, clientId: id, templateId: tpl, ownerUserId: staffId });
      return { id, contactId, onboardingId };
    };
    const clientA = await mkClient("a");
    const clientB = await mkClient("b");
    return {
      workspaceId: ws,
      adminId,
      staffId,
      templateId: tpl,
      clientA,
      clientB,
      ctx: {
        admin: { workspaceId: ws, userId: adminId, role: "admin" },
        staff: { workspaceId: ws, userId: staffId, role: "staff" },
        clientA: { workspaceId: ws, userId: clientA.contactId, role: "client", clientId: clientA.id },
        clientB: { workspaceId: ws, userId: clientB.contactId, role: "client", clientId: clientB.id },
      },
    };
  });
}

export async function itemByKey(onboardingId: string, key: string) {
  return withSysTx(async (tx) =>
    (await tx.one<{ id: string; status: string }>("select id, status from onboarding_items where onboarding_id = $1 and item_key = $2", [onboardingId, key]))!,
  );
}

export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
