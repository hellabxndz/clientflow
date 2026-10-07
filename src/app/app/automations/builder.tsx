"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, ArrowDown, ArrowUp } from "lucide-react";
import {
  ACTION_LABEL,
  CONDITION_LABEL,
  PLACEHOLDER_HELP,
  TRIGGER_INFO,
  TRIGGERS,
  type AutomationAction,
  type Condition,
  type RuleInput,
  type TriggerType,
} from "@/lib/automation/catalog";
import { ActionForm, SubmitButton } from "@/components/forms";
import { saveAutomationRuleAction } from "./actions";
import { CATEGORY_INFO, describeRule, RECIPIENT_LABEL, type Vocabulary } from "./describe";

type AnyRecord = Record<string, unknown>;

const NEW_CONDITION: Record<Condition["type"], () => Condition> = {
  item_status: () => ({ type: "item_status", itemKey: "", state: "approved" }),
  section_complete: () => ({ type: "section_complete", sectionKey: "" }),
  all_required_approved: () => ({ type: "all_required_approved" }),
  critical_complete: () => ({ type: "critical_complete" }),
  readiness_at_least: () => ({ type: "readiness_at_least", percent: 80 }),
  client_type_is: () => ({ type: "client_type_is", clientTypeId: "" }),
  deal_value_at_least: () => ({ type: "deal_value_at_least", amount: 10000 }),
  not_ready_for_kickoff: () => ({ type: "not_ready_for_kickoff" }),
  event_item_is: () => ({ type: "event_item_is", itemKey: "" }),
  event_item_category_is: () => ({ type: "event_item_category_is", category: "brand" }),
  onboarding_has_no_owner: () => ({ type: "onboarding_has_no_owner" }),
};

const NEW_ACTION: Record<AutomationAction["type"], () => AutomationAction> = {
  create_onboarding: () => ({ type: "create_onboarding", templateId: null }),
  assign_template: () => ({ type: "assign_template", templateId: "" }),
  assign_owner: () => ({ type: "assign_owner", owner: "client_type_default" }),
  create_task: () => ({ type: "create_task", title: "", assignee: "onboarding_owner", dueInDays: 2, required: false }),
  request_information: () => ({ type: "request_information", question: "", dueInDays: 3 }),
  request_document: () => ({ type: "request_document", title: "", accept: ["pdf", "png", "jpg"], dueInDays: 5 }),
  send_email: () => ({ type: "send_email", to: "onboarding_owner", subject: "", body: "" }),
  schedule_reminder: () => ({ type: "schedule_reminder", afterDays: 3, subject: "A quick reminder from {{workspace_name}}", body: "Hi! You still have {{outstanding_items}} to finish: {{portal_link}}" }),
  invite_client: () => ({ type: "invite_client" }),
  notify_staff: () => ({ type: "notify_staff", to: "onboarding_owner", message: "", email: false }),
  update_stage: () => ({ type: "update_stage", stage: "at_risk", reason: "" }),
  add_note: () => ({ type: "add_note", body: "" }),
  create_review_task: () => ({ type: "create_review_task", reviewer: "onboarding_owner" }),
  mark_ready_for_kickoff: () => ({ type: "mark_ready_for_kickoff" }),
  trigger_integration: () => ({ type: "trigger_integration", provider: "clickup", name: "Kickoff: {{client_name}}" }),
  chat_notification: () => ({ type: "chat_notification", provider: "slack", message: "" }),
};

const EMPTY: RuleInput = {
  name: "",
  description: "",
  category: "automation",
  trigger: "item_approved",
  triggerConfig: {},
  conditions: [],
  conditionMode: "all",
  actions: [{ type: "notify_staff", to: "onboarding_owner", message: "", email: false }],
  runMode: "once_per_onboarding",
  templateId: null,
};

const encodeWho = (v: unknown) => (v && typeof v === "object" && "userId" in v ? `user:${(v as { userId: string }).userId}` : String(v ?? ""));
const decodeWho = (s: string) => (s.startsWith("user:") ? { userId: s.slice(5) } : s);
const num = (s: string) => (s === "" ? undefined : Number(s));

function Field({ label, children, hint, className }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={className ?? "block min-w-0"}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export function RuleBuilder({ vocab, categories, initial, ruleId }: { vocab: Vocabulary; categories: string[]; initial?: RuleInput; ruleId?: string }) {
  const [rule, setRule] = useState<RuleInput>(() => structuredClone(initial ?? EMPTY));
  const set = (patch: Partial<RuleInput>) => setRule((r) => ({ ...r, ...patch }));
  const info = TRIGGER_INFO[rule.trigger];

  const scopeTemplates = rule.templateId ? vocab.templates.filter((t) => t.id === rule.templateId) : vocab.templates;
  const itemOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of scopeTemplates) for (const s of t.sections) for (const i of s.items) if (!seen.has(i.key)) seen.set(i.key, `${i.title} (${s.title})`);
    return [...seen.entries()];
  }, [scopeTemplates]);
  const sectionOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of scopeTemplates) for (const s of t.sections) if (!seen.has(s.key)) seen.set(s.key, s.title);
    return [...seen.entries()];
  }, [scopeTemplates]);

  const groups = useMemo(() => {
    const g = new Map<string, TriggerType[]>();
    for (const t of TRIGGERS) g.set(TRIGGER_INFO[t].group, [...(g.get(TRIGGER_INFO[t].group) ?? []), t]);
    return [...g.entries()];
  }, []);

  const preview = describeRule(rule, vocab);

  const updateCondition = (i: number, patch: AnyRecord) => set({ conditions: rule.conditions.map((c, j) => (j === i ? ({ ...c, ...patch } as Condition) : c)) });
  const updateAction = (i: number, patch: AnyRecord) => set({ actions: rule.actions.map((a, j) => (j === i ? ({ ...a, ...patch } as AutomationAction) : a)) });
  const moveAction = (i: number, d: -1 | 1) => {
    const next = [...rule.actions];
    const [a] = next.splice(i, 1);
    next.splice(i + d, 0, a);
    set({ actions: next });
  };

  const whoSelect = (value: unknown, onChange: (v: unknown) => void, base: string[]) => (
    <select className="input" value={encodeWho(value)} onChange={(e) => onChange(decodeWho(e.target.value))}>
      {base.map((b) => (
        <option key={b} value={b}>
          {RECIPIENT_LABEL[b].replace(/^the /, "").replace(/^./, (c) => c.toUpperCase())}
        </option>
      ))}
      <optgroup label="Specific person">
        {vocab.staff.map((s) => (
          <option key={s.id} value={`user:${s.id}`}>
            {s.name}
          </option>
        ))}
      </optgroup>
    </select>
  );

  const itemKeyInput = (value: string, onChange: (v: string) => void, allowEmpty = false) => (
    <input
      className="input"
      list="automation-item-keys"
      value={value}
      placeholder={allowEmpty ? "Any item" : "Choose or type an item key"}
      onChange={(e) => onChange(e.target.value.trim())}
    />
  );

  return (
    <ActionForm action={saveAutomationRuleAction} className="space-y-6">
      <input type="hidden" name="rule" value={JSON.stringify(cleanForSave(rule))} />
      {ruleId && <input type="hidden" name="ruleId" value={ruleId} />}
      <datalist id="automation-item-keys">
        {itemOptions.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </datalist>
      <datalist id="automation-section-keys">
        {sectionOptions.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </datalist>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">Basics</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={rule.name} maxLength={120} required onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Ready for Kickoff when access is in" />
          </Field>
          <Field label="Category" hint={CATEGORY_INFO[rule.category].help}>
            <select className="input" value={rule.category} onChange={(e) => set({ category: e.target.value as RuleInput["category"] })}>
              {(Object.keys(CATEGORY_INFO) as RuleInput["category"][]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_INFO[c].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description (optional)" className="block min-w-0 sm:col-span-2">
            <input className="input" value={rule.description ?? ""} maxLength={500} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Only for onboardings using template" hint="Leave on “All templates” to apply everywhere. Item and section pickers below follow this choice.">
            <select className="input" value={rule.templateId ?? ""} onChange={(e) => set({ templateId: e.target.value || null })}>
              <option value="">All templates</option>
              {vocab.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">When</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Trigger" hint={info.help} className="block min-w-0 sm:col-span-2">
            <select
              className="input"
              value={rule.trigger}
              onChange={(e) => {
                const t = e.target.value as TriggerType;
                const unit = TRIGGER_INFO[t].unit;
                set({ trigger: t, triggerConfig: unit === "days" ? { days: 3 } : unit === "hours" ? { hours: 48 } : {} });
              }}
            >
              {groups.map(([group, triggers]) => (
                <optgroup key={group} label={group}>
                  {triggers.map((t) => (
                    <option key={t} value={t}>
                      {TRIGGER_INFO[t].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {info.unit && (
            <Field label={info.unit === "days" ? "Days" : "Hours"}>
              <input
                className="input"
                type="number"
                min={info.unit === "hours" ? 1 : 0}
                max={info.unit === "hours" ? 720 : 90}
                value={(info.unit === "days" ? rule.triggerConfig.days : rule.triggerConfig.hours) ?? ""}
                onChange={(e) => set({ triggerConfig: { ...rule.triggerConfig, [info.unit!]: num(e.target.value) } })}
              />
            </Field>
          )}
          {info.itemFilter && (
            <Field label="Only for item (optional)" hint="Leave empty to react to any item.">
              {itemKeyInput(rule.triggerConfig.itemKey ?? "", (v) => set({ triggerConfig: { ...rule.triggerConfig, itemKey: v || undefined } }), true)}
            </Field>
          )}
        </div>
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-ink-900">Only if (conditions)</h2>
          {rule.conditions.length > 1 && (
            <div className="flex rounded-lg border border-ink-200 p-0.5 text-sm">
              {(["all", "any"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => set({ conditionMode: m })}
                  className={rule.conditionMode === m ? "rounded-md bg-brand-50 px-3 py-1 font-medium text-brand-700" : "px-3 py-1 text-ink-500"}
                >
                  {m === "all" ? "All must match" : "Any can match"}
                </button>
              ))}
            </div>
          )}
        </div>
        {rule.conditions.length === 0 && <p className="mt-3 text-sm text-ink-500">No conditions: the actions run every time the trigger fires (subject to the run mode below).</p>}
        <ul className="mt-4 space-y-3">
          {rule.conditions.map((c, i) => (
            <li key={i} className="rounded-lg border border-ink-200 bg-ink-50/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink-800">
                  {i > 0 && <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-brand-700">{rule.conditionMode === "all" ? "and" : "or"}</span>}
                  {CONDITION_LABEL[c.type]}
                </p>
                <button type="button" className="btn-ghost p-1" aria-label="Remove condition" onClick={() => set({ conditions: rule.conditions.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {(c.type === "item_status" || c.type === "event_item_is") && (
                  <Field label="Item">{itemKeyInput(c.itemKey, (v) => updateCondition(i, { itemKey: v }))}</Field>
                )}
                {c.type === "item_status" && (
                  <Field label="Is">
                    <select className="input" value={c.state} onChange={(e) => updateCondition(i, { state: e.target.value })}>
                      <option value="approved">Approved</option>
                      <option value="submitted">Submitted (or approved)</option>
                      <option value="not_approved">Not yet approved</option>
                    </select>
                  </Field>
                )}
                {c.type === "section_complete" && (
                  <Field label="Section">
                    <input className="input" list="automation-section-keys" value={c.sectionKey} placeholder="Choose or type a section key" onChange={(e) => updateCondition(i, { sectionKey: e.target.value.trim() })} />
                  </Field>
                )}
                {c.type === "readiness_at_least" && (
                  <Field label="Percent">
                    <input className="input" type="number" min={0} max={100} value={c.percent} onChange={(e) => updateCondition(i, { percent: num(e.target.value) ?? 0 })} />
                  </Field>
                )}
                {c.type === "client_type_is" && (
                  <Field label="Client type">
                    <select className="input" value={c.clientTypeId} onChange={(e) => updateCondition(i, { clientTypeId: e.target.value })}>
                      <option value="">Choose…</option>
                      {vocab.clientTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {c.type === "deal_value_at_least" && (
                  <Field label="Amount (USD)">
                    <input className="input" type="number" min={0} value={c.amount} onChange={(e) => updateCondition(i, { amount: num(e.target.value) ?? 0 })} />
                  </Field>
                )}
                {c.type === "event_item_category_is" && (
                  <Field label="Category">
                    <select className="input" value={c.category} onChange={(e) => updateCondition(i, { category: e.target.value })}>
                      {categories.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            </li>
          ))}
        </ul>
        {rule.conditions.length < 10 && (
          <AddSelect
            label="Add condition"
            options={(Object.keys(CONDITION_LABEL) as Condition["type"][]).map((k) => [k, CONDITION_LABEL[k]])}
            onAdd={(k) => set({ conditions: [...rule.conditions, NEW_CONDITION[k as Condition["type"]]()] })}
          />
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">Then (actions run in order)</h2>
        <ul className="mt-4 space-y-3">
          {rule.actions.map((a, i) => (
            <li key={i} className="rounded-lg border border-ink-200 bg-ink-50/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink-800">
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{i + 1}</span>
                  {ACTION_LABEL[a.type]}
                </p>
                <div className="flex shrink-0 gap-1">
                  <button type="button" className="btn-ghost p-1" aria-label="Move up" disabled={i === 0} onClick={() => moveAction(i, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button type="button" className="btn-ghost p-1" aria-label="Move down" disabled={i === rule.actions.length - 1} onClick={() => moveAction(i, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button type="button" className="btn-ghost p-1" aria-label="Remove action" disabled={rule.actions.length === 1} onClick={() => set({ actions: rule.actions.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <ActionInputs action={a} update={(p) => updateAction(i, p)} vocab={vocab} categories={categories} whoSelect={whoSelect} />
            </li>
          ))}
        </ul>
        {rule.actions.length < 10 && (
          <AddSelect
            label="Add action"
            options={(Object.keys(ACTION_LABEL) as AutomationAction["type"][]).map((k) => [k, ACTION_LABEL[k]])}
            onAdd={(k) => set({ actions: [...rule.actions, NEW_ACTION[k as AutomationAction["type"]]()] })}
          />
        )}
        <p className="mt-4 text-xs text-ink-500">
          Placeholders for messages: {PLACEHOLDER_HELP.map((p) => <code key={p} className="mr-1 rounded bg-ink-100 px-1 py-0.5">{p}</code>)}
        </p>
      </section>

      <section className="card p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">How often</h2>
        <div className="mt-3 space-y-2">
          {(
            [
              ["once_per_onboarding", "Once per onboarding", "The rule runs at most once for each client onboarding, even if the trigger fires again later."],
              ["every_event", "Every time the trigger fires", "Runs once for each event (for example each file submitted). The same event never runs the rule twice."],
            ] as const
          ).map(([v, label, help]) => (
            <label key={v} className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-3 has-[:checked]:border-brand-300 has-[:checked]:bg-brand-50/40">
              <input type="radio" className="mt-1" name="runModeChoice" checked={rule.runMode === v} onChange={() => set({ runMode: v })} />
              <span>
                <span className="block text-sm font-medium text-ink-900">{label}</span>
                <span className="block text-xs text-ink-500">{help}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-500">
          Duplicates are prevented by the database: every run is recorded with a unique key (rule + onboarding, or rule + event), so retries, overlapping
          scheduler runs or double clicks can never send the same notification or create the same task twice. Time-based rules run once per item and
          due date (or once per period of inactivity).
        </p>
      </section>

      <section className="card border-brand-200 bg-brand-50/30 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-700">Preview</p>
        <p className="mt-1 text-sm text-ink-800">{preview.sentence}</p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        {!ruleId && (
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" name="enable" defaultChecked /> Turn on after saving
          </label>
        )}
        <SubmitButton pendingText="Saving…">{ruleId ? "Save changes" : "Create automation"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function AddSelect({ label, options, onAdd }: { label: string; options: [string, string][]; onAdd: (k: string) => void }) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Plus className="h-4 w-4 text-ink-400" aria-hidden />
      <select
        className="input max-w-xs"
        aria-label={label}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="">{label}…</option>
        {options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function ActionInputs({
  action: a,
  update,
  vocab,
  categories,
  whoSelect,
}: {
  action: AutomationAction;
  update: (p: AnyRecord) => void;
  vocab: Vocabulary;
  categories: string[];
  whoSelect: (value: unknown, onChange: (v: unknown) => void, base: string[]) => React.ReactNode;
}) {
  const text = (k: string, label: string, value: string | undefined, opts: { area?: boolean; max?: number; placeholder?: string } = {}) => (
    <Field label={label} className={opts.area ? "block min-w-0 sm:col-span-2" : "block min-w-0"}>
      {opts.area ? (
        <textarea className="input min-h-[80px]" value={value ?? ""} maxLength={opts.max} placeholder={opts.placeholder} onChange={(e) => update({ [k]: e.target.value })} />
      ) : (
        <input className="input" value={value ?? ""} maxLength={opts.max} placeholder={opts.placeholder} onChange={(e) => update({ [k]: e.target.value })} />
      )}
    </Field>
  );
  const days = (k: string, label: string, value: number | null | undefined, min = 0) => (
    <Field label={label}>
      <input className="input" type="number" min={min} max={90} value={value ?? ""} onChange={(e) => update({ [k]: num(e.target.value) ?? null })} />
    </Field>
  );
  const templateSelect = (value: string | null | undefined, allowAuto: boolean) => (
    <Field label="Template">
      <select className="input" value={value ?? ""} onChange={(e) => update({ templateId: e.target.value || (allowAuto ? null : "") })}>
        {allowAuto ? <option value="">Use the client type's workflow</option> : <option value="">Choose…</option>}
        {vocab.templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Field>
  );
  let body: React.ReactNode = null;
  switch (a.type) {
    case "create_onboarding":
      body = templateSelect(a.templateId, true);
      break;
    case "assign_template":
      body = templateSelect(a.templateId, false);
      break;
    case "assign_owner":
      body = <Field label="Owner">{whoSelect(a.owner, (v) => update({ owner: v }), ["client_type_default", "account_manager"])}</Field>;
      break;
    case "create_task":
      body = (
        <>
          {text("title", "Task title", a.title, { max: 200 })}
          <Field label="Assign to">{whoSelect(a.assignee, (v) => update({ assignee: v }), ["onboarding_owner", "account_manager"])}</Field>
          {days("dueInDays", "Due in (days)", a.dueInDays)}
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-700">
            <input type="checkbox" checked={!!a.required} onChange={(e) => update({ required: e.target.checked })} /> Required for completion
          </label>
        </>
      );
      break;
    case "request_information":
      body = (
        <>
          {text("question", "Question for the client", a.question, { area: true, max: 1000 })}
          {days("dueInDays", "Due in (days)", a.dueInDays)}
        </>
      );
      break;
    case "request_document":
      body = (
        <>
          {text("title", "Document", a.title, { max: 200 })}
          <Field label="Accepted file types" hint="Comma separated, e.g. pdf, png, jpg">
            <input
              className="input"
              defaultValue={a.accept.join(", ")}
              onChange={(e) => update({ accept: e.target.value.split(/[,\s]+/).map((s) => s.replace(/^\./, "").toLowerCase()).filter(Boolean) })}
            />
          </Field>
          <Field label="Category">
            <select className="input" value={a.category ?? ""} onChange={(e) => update({ category: e.target.value || undefined })}>
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          {days("dueInDays", "Due in (days)", a.dueInDays)}
          {text("description", "Instructions (optional)", a.description, { area: true, max: 1000 })}
        </>
      );
      break;
    case "send_email":
      body = (
        <>
          <Field label="To">
            <select className="input" value={a.to} onChange={(e) => update({ to: e.target.value })}>
              {(["client_contacts", "onboarding_owner", "account_manager", "managers"] as const).map((t) => (
                <option key={t} value={t}>
                  {RECIPIENT_LABEL[t].replace(/^the /, "").replace(/^./, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </Field>
          {text("subject", "Subject", a.subject, { max: 200 })}
          {text("body", "Message", a.body, { area: true, max: 5000 })}
        </>
      );
      break;
    case "schedule_reminder":
      body = (
        <>
          {days("afterDays", "Send after (days)", a.afterDays, 1)}
          {text("subject", "Subject", a.subject, { max: 200 })}
          {text("body", "Message", a.body, { area: true, max: 5000 })}
        </>
      );
      break;
    case "notify_staff":
      body = (
        <>
          <Field label="Notify">{whoSelect(a.to, (v) => update({ to: v }), ["onboarding_owner", "account_manager", "managers", "reviewer", "all_staff"])}</Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-700">
            <input type="checkbox" checked={!!a.email} onChange={(e) => update({ email: e.target.checked })} /> Also send by email
          </label>
          {text("message", "Message", a.message, { area: true, max: 1000, placeholder: "{{client_name}} …" })}
        </>
      );
      break;
    case "update_stage":
      body = (
        <>
          <Field label="Change">
            <select className="input" value={a.stage} onChange={(e) => update({ stage: e.target.value })}>
              <option value="at_risk">Mark At Risk</option>
              <option value="clear_at_risk">Clear At Risk</option>
              <option value="pause">Pause onboarding</option>
              <option value="resume">Resume onboarding</option>
            </select>
          </Field>
          {text("reason", "Reason (optional)", a.reason, { max: 300 })}
        </>
      );
      break;
    case "add_note":
      body = text("body", "Note", a.body, { area: true, max: 2000 });
      break;
    case "create_review_task":
      body = <Field label="Reviewer">{whoSelect(a.reviewer, (v) => update({ reviewer: v }), ["onboarding_owner", "account_manager"])}</Field>;
      break;
    case "trigger_integration":
      body = (
        <>
          <Field label="Project tool" hint="Connect it on the Integrations page. Until then the action is skipped and logged.">
            <select className="input" value={a.provider} onChange={(e) => update({ provider: e.target.value })}>
              <option value="clickup">ClickUp</option>
              <option value="asana">Asana</option>
              <option value="monday">Monday.com</option>
            </select>
          </Field>
          {text("name", "Item name", a.name, { max: 200, placeholder: "Kickoff: {{client_name}}" })}
        </>
      );
      break;
    case "chat_notification":
      body = (
        <>
          <Field label="Channel" hint="Connect it on the Integrations page. Until then the action is skipped and logged.">
            <select className="input" value={a.provider} onChange={(e) => update({ provider: e.target.value })}>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
            </select>
          </Field>
          {text("message", "Message", a.message, { area: true, max: 1000 })}
        </>
      );
      break;
    default:
      return <p className="mt-1 text-xs text-ink-500">No settings needed.</p>;
  }
  return <div className="mt-2 grid gap-3 sm:grid-cols-2">{body}</div>;
}

/** Drops empty optional strings so zod gets clean input. */
function cleanForSave(rule: RuleInput): RuleInput {
  const actions = rule.actions.map((a) => {
    const out: AnyRecord = { ...a };
    for (const k of ["description", "category", "reason", "name"]) if (out[k] === "") delete out[k];
    if ("dueInDays" in out && (out.dueInDays === undefined || Number.isNaN(out.dueInDays))) out.dueInDays = null;
    return out as AutomationAction;
  });
  const triggerConfig = { ...rule.triggerConfig };
  if (!triggerConfig.itemKey) delete triggerConfig.itemKey;
  return { ...rule, name: rule.name.trim(), description: rule.description?.trim() || null, actions, triggerConfig };
}
