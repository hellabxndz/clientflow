"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { str } from "@/lib/action-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marks one of the current user's notifications read. RLS limits updates to the user's own rows. */
export async function markNotificationReadAction(fd: FormData) {
  const auth = await actionAuth("staff");
  const id = str(fd, "id");
  if (!UUID.test(id)) return;
  await withTenant(tenantCtx(auth), (tx) => tx.q("update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null", [id, auth.user.id]));
  revalidatePath("/app", "layout");
}

/** Marks the notification read, then opens its link (internal links only). */
export async function openNotificationAction(fd: FormData) {
  const auth = await actionAuth("staff");
  const id = str(fd, "id");
  if (!UUID.test(id)) return;
  const row = await withTenant(tenantCtx(auth), (tx) =>
    tx.one<{ link: string | null }>("update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning link", [id, auth.user.id]),
  );
  revalidatePath("/app", "layout");
  const link = row?.link;
  redirect(link && link.startsWith("/") && !link.startsWith("//") ? link : "/app/notifications");
}

export async function markAllNotificationsReadAction() {
  const auth = await actionAuth("staff");
  await withTenant(tenantCtx(auth), (tx) => tx.q("update notifications set read_at = now() where user_id = $1 and read_at is null", [auth.user.id]));
  revalidatePath("/app", "layout");
}
