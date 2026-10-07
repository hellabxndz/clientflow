"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, int, optional, str } from "@/lib/action-helpers";
import type { ActionState } from "@/components/forms";

export async function saveClientTypeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const id = optional(fd, "id");
    const name = str(fd, "name");
    if (!name || name.length > 80) return { error: "Enter a name (up to 80 characters)." };
    const description = optional(fd, "description");
    if (description && description.length > 400) return { error: "Keep the description under 400 characters." };
    const templateId = optional(fd, "templateId");
    const ownerId = optional(fd, "defaultOwnerUserId");
    const position = int(fd, "position", 0)!;
    if (position < 0 || position > 999) return { error: "Position must be between 0 and 999." };
    await withTenant(ctx, async (tx) => {
      if (templateId && !(await tx.one("select 1 from templates where id = $1 and not archived", [templateId]))) throw new Error("Choose a template from this workspace.");
      if (ownerId && !(await tx.one("select 1 from memberships where user_id = $1 and role in ('admin', 'manager', 'staff')", [ownerId])))
        throw new Error("Choose a team member as the default owner.");
      const dupe = await tx.one("select 1 from client_types where lower(name) = lower($1) and id is distinct from $2::uuid", [name, id]);
      if (dupe) throw new Error(`A client type named "${name}" already exists.`);
      if (id) {
        const row = await tx.one(
          "update client_types set name = $2, description = $3, template_id = $4, default_owner_user_id = $5, position = $6 where id = $1 returning id",
          [id, name, description, templateId, ownerId, position],
        );
        if (!row) throw new Error("Client type not found.");
        await audit(tx, ctx, "client_type.updated", "client_type", id, `Updated client type "${name}"`);
      } else {
        const row = await tx.one<{ id: string }>(
          `insert into client_types (workspace_id, name, description, template_id, default_owner_user_id, position)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [auth.workspace.id, name, description, templateId, ownerId, position],
        );
        await audit(tx, ctx, "client_type.created", "client_type", row!.id, `Created client type "${name}"`);
      }
    });
    revalidatePath("/app/settings/client-types");
    return { ok: id ? "Saved." : "Client type created." };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteClientTypeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const id = str(fd, "id");
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ name: string }>("delete from client_types where id = $1 returning name", [id]);
      if (!row) throw new Error("Client type not found.");
      await audit(tx, ctx, "client_type.deleted", "client_type", null, `Deleted client type "${row.name}" (clients using it keep their onboardings)`);
    });
    revalidatePath("/app/settings/client-types");
    return { ok: "Deleted." };
  } catch (e) {
    return fail(e);
  }
}
