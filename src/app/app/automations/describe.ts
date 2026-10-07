import { ACTION_LABEL, TRIGGER_INFO, type AutomationAction, type Condition, type RuleInput, type TriggerType } from "@/lib/automation/catalog";

/** Names the rule sentence needs. Plain data so the builder (client) and the pages (server) share it. */
export interface Vocabulary {
  templates: { id: string; name: string; sections: { key: string; title: string; items: { key: string; title: string }[] }[] }[];
  clientTypes: { id: string; name: string }[];
  staff: { id: string; name: string; role: string }[];
}

export const RECIPIENT_LABEL: Record<string, string> = {
  onboarding_owner: "the onboarding owner",
  account_manager: "the account manager",
  managers: "managers",
  reviewer: "the reviewer",
  all_staff: "all staff",
  client_contacts: "the client's contacts",
  client_type_default: "the client type's default owner",
};

export const PROVIDER_NAME: Record<string, string> = { clickup: "ClickUp", asana: "Asana", monday: "Monday.com", slack: "Slack", teams: "Microsoft Teams" };

export const CATEGORY_INFO: Record<RuleInput["category"], { label: string; help: string }> = {
  automation: { label: "Automations", help: "Start onboarding, assign owners, request what's missing and move clients forward." },
  escalation: { label: "Escalations", help: "Alert the right person when a client is late, a review waits too long or a client goes quiet." },
  handoff: { label: "Handoff", help: "When a client is Ready for Kickoff: create the delivery item in your PM tool, post to Slack or Teams, email the team and add the kickoff task." },
};

export function lookups(v: Vocabulary, templateId?: string | null) {
  const items = new Map<string, string>();
  const sections = new Map<string, string>();
  const ordered = templateId ? [...v.templates.filter((t) => t.id === templateId), ...v.templates.filter((t) => t.id !== templateId)] : v.templates;
  for (const t of ordered)
    for (const s of t.sections) {
      if (!sections.has(s.key)) sections.set(s.key, s.title);
      for (const i of s.items) if (!items.has(i.key)) items.set(i.key, i.title);
    }
  return {
    item: (k: string) => items.get(k) ?? k,
    section: (k: string) => sections.get(k) ?? k,
    clientType: (id: string) => v.clientTypes.find((c) => c.id === id)?.name ?? "a deleted client type",
    staff: (id: string) => v.staff.find((s) => s.id === id)?.name ?? "a former team member",
    template: (id: string) => v.templates.find((t) => t.id === id)?.name ?? "a deleted template",
  };
}

type L = ReturnType<typeof lookups>;

export function describeTrigger(trigger: TriggerType, config: RuleInput["triggerConfig"], l: L) {
  const info = TRIGGER_INFO[trigger];
  const item = config?.itemKey ? `"${l.item(config.itemKey)}"` : null;
  const days = config?.days ?? 0;
  const hours = config?.hours ?? 48;
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  switch (trigger) {
    case "deadline_approaching":
      return `${item ?? "a required item"} is due within ${plural(days, "day")}`;
    case "deadline_overdue":
      return `${item ?? "a client requirement"} is ${days ? `${plural(days, "day")} ` : ""}overdue`;
    case "task_overdue":
      return `${item ?? "an internal task"} is ${days ? `${plural(days, "day")} ` : ""}overdue`;
    case "client_inactive":
      return `the client has been inactive for ${plural(days, "day")}`;
    case "review_waiting":
      return `${item ?? "a submission"} has waited ${plural(hours, "hour")} for review`;
    default:
      return item ? `${info.label.toLowerCase()} (${item})` : info.label.toLowerCase();
  }
}

export function describeCondition(c: Condition, l: L) {
  switch (c.type) {
    case "item_status":
      return `${l.item(c.itemKey)} ${c.state === "approved" ? "approved" : c.state === "submitted" ? "submitted" : "not yet approved"}`;
    case "section_complete":
      return `${l.section(c.sectionKey)} section complete`;
    case "all_required_approved":
      return "all required items approved";
    case "critical_complete":
      return "all critical items approved";
    case "readiness_at_least":
      return `readiness at least ${c.percent}%`;
    case "client_type_is":
      return `client type is ${l.clientType(c.clientTypeId)}`;
    case "deal_value_at_least":
      return `contract value at least $${c.amount.toLocaleString("en-US")}`;
    case "not_ready_for_kickoff":
      return "not yet Ready for Kickoff";
    case "event_item_is":
      return `the item is ${l.item(c.itemKey)}`;
    case "event_item_category_is":
      return `the item's category is ${c.category}`;
    case "onboarding_has_no_owner":
      return "the onboarding has no owner";
  }
}

function who(to: unknown, l: L) {
  if (to && typeof to === "object" && "userId" in to) return l.staff(String((to as { userId: string }).userId));
  return RECIPIENT_LABEL[String(to)] ?? String(to);
}

export function describeAction(a: AutomationAction, l: L) {
  switch (a.type) {
    case "create_onboarding":
      return a.templateId ? `start onboarding with ${l.template(a.templateId)}` : "start onboarding (workflow from the client type)";
    case "assign_template":
      return `start onboarding with ${l.template(a.templateId)}`;
    case "assign_owner":
      return `assign ${who(a.owner, l)} as owner`;
    case "create_task":
      return `create task "${a.title}" for ${who(a.assignee, l)}${a.dueInDays != null ? `, due in ${a.dueInDays} day${a.dueInDays === 1 ? "" : "s"}` : ""}`;
    case "request_information":
      return `ask the client: "${a.question}"`;
    case "request_document":
      return `request document "${a.title}"`;
    case "send_email":
      return `email ${who(a.to, l)}: "${a.subject}"`;
    case "schedule_reminder":
      return `remind the client after ${a.afterDays} days`;
    case "invite_client":
      return "send the client their portal invitation";
    case "notify_staff":
      return `notify ${who(a.to, l)}${a.email ? " (in app and by email)" : ""}`;
    case "update_stage":
      return a.stage === "at_risk" ? "mark At Risk" : a.stage === "clear_at_risk" ? "clear At Risk" : a.stage === "pause" ? "pause the onboarding" : "resume the onboarding";
    case "add_note":
      return "add an internal note";
    case "create_review_task":
      return `create a review task for ${who(a.reviewer, l)}`;
    case "mark_ready_for_kickoff":
      return "mark Ready for Kickoff";
    case "trigger_integration":
      return `create the handoff item in ${PROVIDER_NAME[a.provider]}`;
    case "chat_notification":
      return `post to ${PROVIDER_NAME[a.provider]}`;
    default:
      return ACTION_LABEL[(a as AutomationAction).type] ?? "run an action";
  }
}

export function describeRule(rule: Pick<RuleInput, "trigger" | "triggerConfig" | "conditions" | "conditionMode" | "actions" | "templateId">, v: Vocabulary) {
  const l = lookups(v, rule.templateId);
  const when = describeTrigger(rule.trigger, rule.triggerConfig ?? {}, l);
  const conditions = rule.conditions.map((c) => describeCondition(c, l));
  const actions = rule.actions.map((a) => describeAction(a, l));
  const joiner = rule.conditionMode === "any" ? " or " : " and ";
  const sentence = `When ${when}${conditions.length ? `${rule.conditions.length > 1 && rule.conditionMode === "any" ? " and any of: " : " and "}${conditions.join(joiner)}` : ""} → ${actions.join(", ")}.`;
  return { when, conditions, actions, sentence, joiner: rule.conditionMode === "any" ? "OR" : "AND", scope: rule.templateId ? l.template(rule.templateId) : null };
}

/** DB row → the builder's input shape. */
export function rowToInput(r: {
  name: string;
  description: string | null;
  category: RuleInput["category"];
  trigger: string;
  trigger_config: RuleInput["triggerConfig"] | null;
  conditions: Condition[];
  condition_mode: "all" | "any";
  actions: AutomationAction[];
  run_mode: RuleInput["runMode"];
  template_id: string | null;
}): RuleInput {
  return {
    name: r.name,
    description: r.description,
    category: r.category,
    trigger: r.trigger as TriggerType,
    triggerConfig: r.trigger_config ?? {},
    conditions: r.conditions ?? [],
    conditionMode: r.condition_mode,
    actions: r.actions ?? [],
    runMode: r.run_mode,
    templateId: r.template_id,
  };
}
