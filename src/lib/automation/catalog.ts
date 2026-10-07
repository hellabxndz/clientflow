import { z } from "zod";

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const EVENT_TRIGGERS = [
  "client_created",
  "deal_imported",
  "onboarding_started",
  "form_submitted",
  "item_submitted",
  "file_uploaded",
  "file_approved",
  "file_rejected",
  "task_completed",
  "item_approved",
  "item_status_changed",
  "all_required_completed",
  "ready_for_kickoff",
  "onboarding_approved",
  "onboarding_paused",
  "onboarding_resumed",
] as const;

export const TIME_TRIGGERS = ["deadline_approaching", "deadline_overdue", "client_inactive", "review_waiting", "task_overdue"] as const;

export const TRIGGERS = [...EVENT_TRIGGERS, ...TIME_TRIGGERS] as const;
export type TriggerType = (typeof TRIGGERS)[number];

export const TRIGGER_INFO: Record<TriggerType, { label: string; help: string; group: string; unit?: "days" | "hours"; itemFilter?: boolean }> = {
  client_created: { label: "Client created", help: "A client is added by hand, by import or from a CRM.", group: "Clients" },
  deal_imported: { label: "Closed-won deal received", help: "A CRM deal reaches Closed Won and arrives through an integration.", group: "Clients" },
  onboarding_started: { label: "Onboarding started", help: "A new onboarding is created for a client.", group: "Onboarding" },
  form_submitted: { label: "Form submitted", help: "The client submits a form.", group: "Client activity", itemFilter: true },
  item_submitted: { label: "Client submits any item", help: "Any form, file request, access request or question is submitted.", group: "Client activity", itemFilter: true },
  file_uploaded: { label: "File uploaded", help: "A new file or file version is uploaded.", group: "Client activity", itemFilter: true },
  file_approved: { label: "File approved", help: "Staff approve a file request.", group: "Reviews", itemFilter: true },
  file_rejected: { label: "File rejected", help: "Staff send a file request back for a new version.", group: "Reviews", itemFilter: true },
  task_completed: { label: "Internal task completed", help: "An internal task is marked done.", group: "Reviews", itemFilter: true },
  item_approved: { label: "Any requirement approved", help: "Any item is approved or completed.", group: "Reviews", itemFilter: true },
  item_status_changed: {
    label: "Any requirement changes status",
    help: "Re-checks the conditions whenever anything moves. Use with conditions such as \"Google Ads access approved\".",
    group: "Reviews",
    itemFilter: true,
  },
  all_required_completed: { label: "All required items completed", help: "Every required item in the onboarding is approved.", group: "Onboarding" },
  ready_for_kickoff: { label: "Ready for kickoff", help: "The onboarding is marked Ready for Kickoff.", group: "Onboarding" },
  onboarding_approved: { label: "Onboarding approved", help: "A manager approves the completed onboarding.", group: "Onboarding" },
  onboarding_paused: { label: "Onboarding paused", help: "Someone pauses the onboarding.", group: "Onboarding" },
  onboarding_resumed: { label: "Onboarding resumed", help: "A paused onboarding is resumed.", group: "Onboarding" },
  deadline_approaching: { label: "Deadline approaching", help: "An outstanding requirement is due within N days.", group: "Time", unit: "days", itemFilter: true },
  deadline_overdue: { label: "Deadline overdue", help: "A client requirement is at least N days overdue.", group: "Time", unit: "days", itemFilter: true },
  client_inactive: { label: "Client inactive", help: "The client hasn't done anything for N days while items are outstanding.", group: "Time", unit: "days" },
  review_waiting: { label: "Review waiting", help: "A submission has waited N hours for staff review.", group: "Time", unit: "hours" },
  task_overdue: { label: "Internal task overdue", help: "An internal task is at least N days overdue.", group: "Time", unit: "days" },
};

/** Which emitted event types each rule trigger listens to. */
const TRIGGER_EVENTS: Partial<Record<TriggerType, string[]>> = {
  item_submitted: ["form_submitted", "item_submitted"],
  item_approved: ["item_approved", "file_approved", "task_completed"],
  item_status_changed: [
    "form_submitted",
    "item_submitted",
    "item_approved",
    "file_approved",
    "task_completed",
    "file_rejected",
    "item_changes_requested",
    "item_status_changed",
  ],
};

export function triggersForEvent(eventType: string): TriggerType[] {
  return (EVENT_TRIGGERS as readonly TriggerType[]).filter((t) => (TRIGGER_EVENTS[t] ?? [t]).includes(eventType));
}

export function isTimeTrigger(t: string): t is (typeof TIME_TRIGGERS)[number] {
  return (TIME_TRIGGERS as readonly string[]).includes(t);
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item_status"), itemKey: z.string().min(1).max(60), state: z.enum(["approved", "submitted", "not_approved"]) }),
  z.object({ type: z.literal("section_complete"), sectionKey: z.string().min(1).max(60) }),
  z.object({ type: z.literal("all_required_approved") }),
  z.object({ type: z.literal("critical_complete") }),
  z.object({ type: z.literal("readiness_at_least"), percent: z.number().int().min(0).max(100) }),
  z.object({ type: z.literal("client_type_is"), clientTypeId: z.string().uuid() }),
  z.object({ type: z.literal("deal_value_at_least"), amount: z.number().min(0) }),
  z.object({ type: z.literal("not_ready_for_kickoff") }),
  z.object({ type: z.literal("event_item_is"), itemKey: z.string().min(1).max(60) }),
  z.object({ type: z.literal("event_item_category_is"), category: z.string().min(1).max(40) }),
  z.object({ type: z.literal("onboarding_has_no_owner") }),
]);
export type Condition = z.infer<typeof conditionSchema>;

export const CONDITION_LABEL: Record<Condition["type"], string> = {
  item_status: "A specific requirement is…",
  section_complete: "Every required item in a section is approved",
  all_required_approved: "All required items are approved",
  critical_complete: "All critical items are approved",
  readiness_at_least: "Readiness score is at least…",
  client_type_is: "Client type is…",
  deal_value_at_least: "Contract value is at least…",
  not_ready_for_kickoff: "Not yet marked Ready for Kickoff",
  event_item_is: "The item that triggered this is…",
  event_item_category_is: "The triggering item's category is…",
  onboarding_has_no_owner: "The onboarding has no owner",
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const recipient = z.union([
  z.enum(["onboarding_owner", "account_manager", "managers", "reviewer", "all_staff"]),
  z.object({ userId: z.string().uuid() }),
]);
const assignee = z.union([z.enum(["onboarding_owner", "account_manager"]), z.object({ userId: z.string().uuid() })]);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_onboarding"), templateId: z.string().uuid().nullable().optional() }),
  z.object({ type: z.literal("assign_template"), templateId: z.string().uuid() }),
  z.object({ type: z.literal("assign_owner"), owner: z.union([z.literal("client_type_default"), z.literal("account_manager"), z.object({ userId: z.string().uuid() })]) }),
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1).max(200),
    assignee,
    dueInDays: z.number().int().min(0).max(90).nullable().optional(),
    required: z.boolean().optional(),
  }),
  z.object({ type: z.literal("request_information"), question: z.string().min(3).max(1000), dueInDays: z.number().int().min(0).max(90).nullable().optional() }),
  z.object({
    type: z.literal("request_document"),
    title: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    accept: z.array(z.string().min(1).max(10)).min(1).max(15),
    category: z.string().max(40).optional(),
    dueInDays: z.number().int().min(0).max(90).nullable().optional(),
  }),
  z.object({
    type: z.literal("send_email"),
    to: z.enum(["client_contacts", "onboarding_owner", "account_manager", "managers"]),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(5000),
  }),
  z.object({ type: z.literal("schedule_reminder"), afterDays: z.number().int().min(1).max(60), subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) }),
  z.object({ type: z.literal("invite_client") }),
  z.object({ type: z.literal("notify_staff"), to: recipient, message: z.string().min(1).max(1000), email: z.boolean().optional() }),
  z.object({ type: z.literal("update_stage"), stage: z.enum(["at_risk", "clear_at_risk", "pause", "resume"]), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal("add_note"), body: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("create_review_task"), reviewer: assignee }),
  z.object({ type: z.literal("mark_ready_for_kickoff") }),
  z.object({ type: z.literal("trigger_integration"), provider: z.enum(["clickup", "asana", "monday"]), name: z.string().max(200).optional() }),
  z.object({ type: z.literal("chat_notification"), provider: z.enum(["slack", "teams"]), message: z.string().min(1).max(1000) }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const ACTION_LABEL: Record<AutomationAction["type"], string> = {
  create_onboarding: "Create onboarding (template from client type)",
  assign_template: "Create onboarding from a specific template",
  assign_owner: "Assign internal owner",
  create_task: "Create internal task",
  request_information: "Request information from the client",
  request_document: "Request a document",
  send_email: "Send email",
  schedule_reminder: "Schedule a client reminder",
  invite_client: "Send the client their portal invitation",
  notify_staff: "Notify staff",
  update_stage: "Update onboarding stage",
  add_note: "Add internal note",
  create_review_task: "Create review task",
  mark_ready_for_kickoff: "Mark Ready for Kickoff",
  trigger_integration: "Project-management handoff",
  chat_notification: "Send Slack or Teams message",
};

export const ruleSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional().nullable(),
  category: z.enum(["automation", "escalation", "handoff"]),
  trigger: z.enum(TRIGGERS),
  triggerConfig: z
    .object({
      days: z.number().int().min(0).max(90).optional(),
      hours: z.number().int().min(1).max(720).optional(),
      itemKey: z.string().max(60).optional(),
    })
    .default({}),
  conditions: z.array(conditionSchema).max(10),
  conditionMode: z.enum(["all", "any"]),
  actions: z.array(actionSchema).min(1).max(10),
  runMode: z.enum(["once_per_onboarding", "every_event"]),
  templateId: z.string().uuid().nullable().optional(),
});
export type RuleInput = z.infer<typeof ruleSchema>;

export const PLACEHOLDER_HELP = ["{{client_name}}", "{{onboarding_name}}", "{{item_title}}", "{{readiness}}", "{{owner_name}}", "{{outstanding_items}}", "{{portal_link}}", "{{workspace_name}}"];
