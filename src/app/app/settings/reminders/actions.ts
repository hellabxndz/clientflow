"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, optional, str } from "@/lib/action-helpers";
import { ITEM_SCOPE_LABEL, REMINDABLE_STATUSES, renderReminder, runReminders, type ItemScope, type ReminderRule } from "@/lib/reminders";
import type { ActionState } from "@/components/forms";

function parseRule(fd: FormData) {
  const trigger = str(fd, "trigger");
  if (!["before_due", "overdue", "no_activity"].includes(trigger)) throw new Error("Choose when the reminder is sent.");
  const offset = Number(str(fd, "offsetDays") || 0);
  const repeat = str(fd, "repeatEveryDays") ? Number(str(fd, "repeatEveryDays")) : null;
  const hour = Number(str(fd, "sendHour") || 9);
  if (!Number.isInteger(offset) || offset < 0 || offset > 60) throw new Error("Days must be between 0 and 60.");
  if (repeat != null && (!Number.isInteger(repeat) || repeat < 1 || repeat > 30)) throw new Error("Repeat must be between 1 and 30 days.");
  if (!Number.isInteger(hour) || hour < 0 || hour > 19) throw new Error("Send hour must be between 0 and 19 (reminders never go out after 8pm local time).");
  const scope = (str(fd, "itemScope") || "all") as ItemScope;
  if (!(scope in ITEM_SCOPE_LABEL)) throw new Error("Choose which items the reminder covers.");
  const name = str(fd, "name");
  const subject = str(fd, "subject");
  const body = str(fd, "body");
  if (!name || !subject || !body) throw new Error("Name, subject and message are required.");
  if (name.length > 120 || subject.length > 200 || body.length > 4000) throw new Error("Name, subject or message is too long.");
  if (!body.includes("{{item_list}}")) throw new Error("The message must include {{item_list}} so clients see what's outstanding.");
  return {
    name,
    trigger,
    offset,
    repeat: trigger === "before_due" ? null : repeat,
    hour,
    subject,
    body,
    scope,
    notifyOwner: fd.get("notifyOwner") === "on",
    businessDaysOnly: fd.get("businessDaysOnly") === "on",
    templateId: optional(fd, "templateId"),
  };
}

export async function saveReminderRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const r = parseRule(fd);
    const id = optional(fd, "ruleId");
    await withTenant(ctx, async (tx) => {
      if (r.templateId && !(await tx.one("select 1 from templates where id = $1", [r.templateId]))) throw new Error("Choose a template from this workspace.");
      const params = [r.name, r.trigger, r.offset, r.repeat, r.hour, r.subject, r.body, r.scope, r.notifyOwner, r.businessDaysOnly, r.templateId];
      if (id) {
        // Any edit disables the rule and requires a fresh preview before re-enabling.
        const row = await tx.one(
          `update reminder_rules set name=$2, trigger=$3, offset_days=$4, repeat_every_days=$5, send_hour=$6, subject=$7, body=$8,
             item_scope=$9, notify_owner=$10, business_days_only=$11, template_id=$12, enabled=false, previewed_at=null where id=$1 returning id`,
          [id, ...params],
        );
        if (!row) throw new Error("Reminder not found.");
        await audit(tx, ctx, "reminder_rule.updated", "reminder_rule", id, `Edited reminder "${r.name}" (disabled until previewed)`);
      } else {
        const row = await tx.one<{ id: string }>(
          `insert into reminder_rules (workspace_id, name, trigger, offset_days, repeat_every_days, send_hour, subject, body, item_scope, notify_owner,
             business_days_only, template_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [auth.workspace.id, ...params],
        );
        await audit(tx, ctx, "reminder_rule.created", "reminder_rule", row!.id, `Created reminder "${r.name}"`);
      }
    });
    revalidatePath("/app/settings/reminders");
    return { ok: id ? "Saved. Preview it again before enabling." : "Created. Preview it, then enable it." };
  } catch (e) {
    return fail(e);
  }
}

export async function previewReminderRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const ruleId = str(fd, "ruleId");
    const data = await withTenant(ctx, async (tx) => {
      const rule = await tx.one<ReminderRule>("select * from reminder_rules where id = $1", [ruleId]);
      if (!rule) throw new Error("Reminder not found.");
      const scopeSql = rule.item_scope === "all" ? "" : " and i.kind = $2";
      const args: unknown[] = [REMINDABLE_STATUSES];
      if (rule.item_scope !== "all") args.push(rule.item_scope);
      const scopeArgs = [...args];
      const templateSql = rule.template_id ? ` and o.template_id = $${args.length + 1}` : "";
      if (rule.template_id) args.push(rule.template_id);
      const sample = await tx.one<{ client_name: string; timezone: string; contact: string | null; onboarding_id: string; owner: string | null }>(
        `select c.name as client_name, c.timezone, c.primary_contact_name as contact, o.id as onboarding_id, u.name as owner
         from onboardings o join clients c on c.id = o.client_id left join users u on u.id = o.owner_user_id
         where o.status = 'active' and c.archived_at is null${templateSql}
         order by (select count(*) from onboarding_items i where i.onboarding_id = o.id and i.status = any($1) and i.audience = 'client'
                   and i.removed_at is null${scopeSql}) desc limit 1`,
        args,
      );
      const items = sample
        ? await tx.q<{ id: string; title: string; due_at: Date | null; status: string; updated_at: Date }>(
            `select i.id, i.title, i.due_at, i.status, i.updated_at from onboarding_items i where i.onboarding_id = $${scopeArgs.length + 1} and i.audience = 'client'
             and i.removed_at is null and i.status = any($1)${scopeSql} order by i.due_at nulls last limit 5`,
            [...scopeArgs, sample.onboarding_id],
          )
        : [];
      const shown = items.length ? items : [{ id: "x", title: "Example requirement", due_at: new Date(Date.now() + 2 * 86400000), status: "not_started", updated_at: new Date() }];
      const rendered = renderReminder(rule, {
        contactName: sample?.contact?.split(" ")[0] ?? "Alex",
        clientName: sample?.client_name ?? "Example Client",
        workspaceName: auth.workspace.name,
        items: shown,
        timeZone: sample?.timezone ?? auth.workspace.timezone,
        accountManager: sample?.owner ?? null,
      });
      await tx.q("update reminder_rules set previewed_at = now() where id = $1", [ruleId]);
      await audit(tx, ctx, "reminder_rule.previewed", "reminder_rule", ruleId, `Previewed reminder "${rule.name}"`);
      return {
        ...rendered,
        sampleClient: sample && items.length ? sample.client_name : "an example client (no active onboarding currently matches this rule)",
        timeZone: sample?.timezone ?? auth.workspace.timezone,
      };
    });
    revalidatePath("/app/settings/reminders");
    return { ok: "", data };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleReminderRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const enable = str(fd, "enabled") === "true";
    const id = str(fd, "ruleId");
    await withTenant(ctx, async (tx) => {
      const rule = await tx.one<{ name: string; previewed_at: Date | null }>("select name, previewed_at from reminder_rules where id = $1", [id]);
      if (!rule) throw new Error("Reminder not found.");
      if (enable && !rule.previewed_at) throw new Error("Preview this reminder before enabling it.");
      await tx.q("update reminder_rules set enabled = $2 where id = $1", [id, enable]);
      await audit(tx, ctx, enable ? "reminder_rule.enabled" : "reminder_rule.disabled", "reminder_rule", id, `${enable ? "Enabled" : "Disabled"} reminder "${rule.name}"`);
    });
    revalidatePath("/app/settings/reminders");
    return { ok: enable ? "Enabled." : "Disabled." };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteReminderRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ name: string }>("delete from reminder_rules where id = $1 returning name", [str(fd, "ruleId")]);
      if (row) await audit(tx, ctx, "reminder_rule.deleted", "reminder_rule", null, `Deleted reminder "${row.name}"`);
    });
    revalidatePath("/app/settings/reminders");
    return { ok: "Deleted." };
  } catch (e) {
    return fail(e);
  }
}

export async function runRemindersAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const s = await runReminders({ workspaceId: auth.workspace.id });
    await withTenant(tenantCtx(auth), (tx) =>
      audit(
        tx,
        tenantCtx(auth),
        "reminder.run",
        null,
        null,
        `Ran reminders manually: ${s.sent} sent, ${s.simulated} simulated, ${s.failed} failed, ${s.cancelled} cancelled, ${s.skipped} skipped, ${s.duplicatesPrevented} duplicates prevented`,
      ),
    );
    revalidatePath("/app/settings", "layout");
    return {
      ok: `Done: ${s.sent} sent, ${s.simulated} recorded in the demo outbox, ${s.failed} failed, ${s.cancelled} cancelled, ${s.skipped} skipped, ${s.duplicatesPrevented} duplicate${s.duplicatesPrevented === 1 ? "" : "s"} prevented. Only clients inside their send window are included.`,
    };
  } catch (e) {
    return fail(e);
  }
}
