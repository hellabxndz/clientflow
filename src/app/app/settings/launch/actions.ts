"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, str } from "@/lib/action-helpers";
import { MANUAL_LAUNCH_KEYS, type ManualLaunchKey } from "@/lib/launch";
import type { ActionState } from "@/components/forms";

const LABEL: Record<ManualLaunchKey, string> = {
  test_onboarding: "Demo client tested",
  portal_reviewed: "Portal reviewed",
  security_review: "Security and pilot readiness reviewed",
};

export async function toggleLaunchItemAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const key = str(fd, "key") as ManualLaunchKey;
    if (!MANUAL_LAUNCH_KEYS.includes(key)) return { error: "Unknown checklist item." };
    const done = str(fd, "done") === "true";
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set launch_checklist = launch_checklist || jsonb_build_object($2::text, $3::jsonb) where id = $1", [
        auth.workspace.id,
        key,
        JSON.stringify({ done, at: new Date().toISOString(), by: auth.user.id }),
      ]);
      await audit(tx, ctx, done ? "launch.item_done" : "launch.item_reopened", null, null, `${done ? "Checked off" : "Reopened"} launch step "${LABEL[key]}"`);
    });
    revalidatePath("/app/settings/launch");
    return { ok: done ? "Marked done." : "Reopened." };
  } catch (e) {
    return fail(e);
  }
}

export async function setLaunchedAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const launch = str(fd, "launch") === "true";
    await withTenant(ctx, async (tx) => {
      await tx.q(`update workspaces set launched_at = ${launch ? "coalesce(launched_at, now())" : "null"} where id = $1`, [auth.workspace.id]);
      await audit(tx, ctx, launch ? "launch.launched" : "launch.unlaunched", null, null, launch ? "Marked the workspace as launched" : "Cleared the launch date");
    });
    revalidatePath("/app", "layout");
    return { ok: launch ? "Launched. Reports now compare onboarding before and after today." : "Launch date cleared." };
  } catch (e) {
    return fail(e);
  }
}
