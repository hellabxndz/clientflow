"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveRuleAction } from "../../actions";
import type { ReminderRule } from "@/lib/reminders";

const DEFAULT_BODY = "Hi {{contact_name}},\n\nA friendly reminder that these items are still open:\n\n{{item_list}}\n\nYou can finish them here: {{portal_link}}\n\nThank you,\n{{workspace_name}}";

export function RuleForm({ rule }: { rule?: ReminderRule }) {
  const [trigger, setTrigger] = useState(rule?.trigger ?? "overdue");
  return (
    <ActionForm action={saveRuleAction} className="space-y-3" resetOnSuccess={!rule}>
      {rule && <input type="hidden" name="ruleId" value={rule.id} />}
      <div>
        <label className="label">Name</label>
        <input name="name" className="input" defaultValue={rule?.name ?? ""} required />
      </div>
      <div>
        <label className="label">Send</label>
        <select name="trigger" className="input" value={trigger} onChange={(e) => setTrigger(e.target.value as ReminderRule["trigger"])}>
          <option value="before_due">Before the due date</option>
          <option value="overdue">After an item is overdue</option>
          <option value="no_activity">When nothing has happened for a while</option>
        </select>
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
        <label className="label">Subject</label>
        <input name="subject" className="input" defaultValue={rule?.subject ?? "Reminder: onboarding items for {{client_name}}"} required />
      </div>
      <div>
        <label className="label">Message</label>
        <textarea name="body" className="input min-h-[160px] text-sm" defaultValue={rule?.body ?? DEFAULT_BODY} required />
      </div>
      <p className="text-xs text-ink-500">Saved reminders start switched off. Preview one before enabling it.</p>
      <SubmitButton pendingText="Saving…">{rule ? "Save changes" : "Create reminder"}</SubmitButton>
    </ActionForm>
  );
}
