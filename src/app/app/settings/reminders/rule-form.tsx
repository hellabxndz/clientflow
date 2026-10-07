"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveReminderRuleAction } from "./actions";
import type { ReminderRule } from "@/lib/reminders";

export function RuleForm({
  rule,
  templates,
  scopes,
  defaultBody,
}: {
  rule?: ReminderRule;
  templates: { id: string; name: string }[];
  scopes: { value: string; label: string }[];
  defaultBody: string;
}) {
  const [trigger, setTrigger] = useState(rule?.trigger ?? "overdue");
  return (
    <ActionForm action={saveReminderRuleAction} className="space-y-3" resetOnSuccess={!rule}>
      {rule && <input type="hidden" name="ruleId" value={rule.id} />}
      <div>
        <label className="label">Name</label>
        <input name="name" className="input" defaultValue={rule?.name ?? ""} maxLength={120} required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Send</label>
          <select name="trigger" className="input" value={trigger} onChange={(e) => setTrigger(e.target.value as ReminderRule["trigger"])}>
            <option value="before_due">Before the due date</option>
            <option value="overdue">After an item is overdue</option>
            <option value="no_activity">When nothing has happened for a while</option>
          </select>
        </div>
        <div>
          <label className="label">Items covered</label>
          <select name="itemScope" className="input" defaultValue={rule?.item_scope ?? "all"}>
            {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label text-xs">{trigger === "before_due" ? "Days before" : trigger === "overdue" ? "Days overdue" : "Idle days"}</label>
          <input name="offsetDays" type="number" min={0} max={60} className="input" defaultValue={rule?.offset_days ?? 2} />
        </div>
        <div>
          <label className="label text-xs">Repeat every</label>
          <input name="repeatEveryDays" type="number" min={1} max={30} className="input" defaultValue={rule?.repeat_every_days ?? ""} placeholder="once" disabled={trigger === "before_due"} />
        </div>
        <div>
          <label className="label text-xs">Hour (client time)</label>
          <input name="sendHour" type="number" min={0} max={19} className="input" defaultValue={rule?.send_hour ?? 9} />
        </div>
      </div>
      <div>
        <label className="label">Only for onboardings using</label>
        <select name="templateId" className="input" defaultValue={rule?.template_id ?? ""}>
          <option value="">Any template</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div className="space-y-2 rounded-lg bg-ink-50 p-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="businessDaysOnly" defaultChecked={rule?.business_days_only ?? true} className="mt-0.5 h-4 w-4 rounded" />
          <span>Business days only <span className="block text-xs text-ink-500">Skips days outside the workspace&apos;s business days.</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="notifyOwner" defaultChecked={rule?.notify_owner ?? false} className="mt-0.5 h-4 w-4 rounded" />
          <span>Notify the account owner <span className="block text-xs text-ink-500">Internal copy: an in-app notification to the onboarding owner when a reminder goes out.</span></span>
        </label>
      </div>
      <div>
        <label className="label">Subject</label>
        <input name="subject" className="input" defaultValue={rule?.subject ?? "Reminder: onboarding items for {{client_name}}"} maxLength={200} required />
      </div>
      <div>
        <label className="label">Message</label>
        <textarea name="body" className="input min-h-[180px] text-sm" defaultValue={rule?.body ?? defaultBody} maxLength={4000} required />
      </div>
      <p className="text-xs text-ink-500">Saved reminders start switched off. Preview one before enabling it; editing a rule switches it off again until it is previewed.</p>
      <SubmitButton pendingText="Saving…">{rule ? "Save changes" : "Create reminder"}</SubmitButton>
    </ActionForm>
  );
}
