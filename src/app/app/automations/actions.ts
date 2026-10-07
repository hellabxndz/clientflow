"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, str } from "@/lib/action-helpers";
import { ruleSchema } from "@/lib/automation/catalog";
import { processPendingEvents, runTimeTriggers } from "@/lib/automation/engine";
import type { ActionState } from "@/components/forms";

function parseRule(fd: FormData) {
  let raw: unknown;
  try {
    raw = JSON.parse(str(fd, "rule") || "null");
  } catch {
    throw new Error("The rule could not be read. Reload the page and try again.");
  }
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length ? `${issue.path.join(" › ")}: ` : "";
    throw new Error(`Check the rule. ${where}${issue.message}`);
  }
  return parsed.data;
}

export async function saveAutomationRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = str(fd, "ruleId");
  try {
    const auth = await actionAuth("manager");
    const rule = parseRule(fd);
    const ctx = tenantCtx(auth);
    id = await withTenant(ctx, async (tx) => {
      if (rule.templateId && !(await tx.one("select 1 from templates where id = $1", [rule.templateId]))) throw new Error("That template no longer exists.");
      const values = [
        rule.name,
        rule.description || null,
        rule.category,
        rule.trigger,
        JSON.stringify(rule.triggerConfig ?? {}),
        JSON.stringify(rule.conditions),
        rule.conditionMode,
        JSON.stringify(rule.actions),
        rule.runMode,
        rule.templateId ?? null,
      ];
      if (id) {
        const row = await tx.one<{ id: string }>(
          `update automation_rules set name = $2, description = $3, category = $4, trigger = $5, trigger_config = $6, conditions = $7,
             condition_mode = $8, actions = $9, run_mode = $10, template_id = $11, updated_at = now()
           where id = $1 returning id`,
          [id, ...values],
        );
        if (!row) throw new Error("That automation no longer exists.");
        await audit(tx, ctx, "automation.updated", "automation_rule", id, `Updated automation "${rule.name}"`, { trigger: rule.trigger });
        return id;
      }
      const row = await tx.one<{ id: string }>(
        `insert into automation_rules (workspace_id, name, description, category, trigger, trigger_config, conditions, condition_mode, actions, run_mode,
           template_id, enabled, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [auth.workspace.id, ...values, fd.get("enable") === "on", auth.user.id],
      );
      await audit(tx, ctx, "automation.created", "automation_rule", row!.id, `Created automation "${rule.name}"`, { trigger: rule.trigger });
      return row!.id;
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/app/automations");
  redirect(`/app/automations?saved=${id}`);
}

export async function toggleAutomationRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const enabled = str(fd, "enabled") === "true";
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ name: string }>("update automation_rules set enabled = $2, updated_at = now() where id = $1 returning name", [str(fd, "ruleId"), enabled]);
      if (!row) throw new Error("That automation no longer exists.");
      await audit(tx, ctx, "automation.toggled", "automation_rule", str(fd, "ruleId"), `${enabled ? "Turned on" : "Turned off"} automation "${row.name}"`, { enabled });
    });
    revalidatePath("/app/automations");
    return { ok: enabled ? "Turned on" : "Turned off" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteAutomationRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ name: string }>("delete from automation_rules where id = $1 returning name", [str(fd, "ruleId")]);
      if (!row) throw new Error("That automation no longer exists.");
      await audit(tx, ctx, "automation.deleted", "automation_rule", null, `Deleted automation "${row.name}" and its run history`, { ruleId: str(fd, "ruleId") });
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/app/automations");
  redirect("/app/automations");
}

/** Processes this workspace's queued events and time-based rules now (the scheduler does this every few minutes). */
export async function processAutomationsNowAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const events = await processPendingEvents({ workspaceId: auth.workspace.id });
    const time = await runTimeTriggers({ workspaceId: auth.workspace.id });
    const follow = await processPendingEvents({ workspaceId: auth.workspace.id });
    revalidatePath("/app/automations/activity");
    const runs = events.runs + time.runs + follow.runs;
    return { ok: `Processed ${events.processed + follow.processed} event${events.processed + follow.processed === 1 ? "" : "s"}; ${runs} rule run${runs === 1 ? "" : "s"}.` };
  } catch (e) {
    return fail(e);
  }
}
