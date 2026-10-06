"use client";

import { useActionState, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import type { TemplateContent, TemplateItem, FormField } from "@/lib/templates";
import { saveTemplateAction } from "../../actions";
import { KIND_LABEL } from "@/components/kind";

type Section = TemplateContent["sections"][number];
const FIELD_TYPES: FormField["type"][] = ["text", "textarea", "email", "url", "phone", "number", "date", "select", "multiselect"];

function makeKey(title: string, taken: Set<string>) {
  const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "item").slice(0, 40);
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

function newItem(kind: TemplateItem["kind"], taken: Set<string>): TemplateItem {
  const title = kind === "task" ? "New internal task" : `New ${KIND_LABEL[kind].toLowerCase()}`;
  const base: TemplateItem = { key: makeKey(title, taken), kind, title, audience: kind === "task" ? "internal" : "client", required: true, dueOffsetDays: 7 };
  if (kind === "form") base.fields = [{ key: "answer", label: "Your answer", type: "text", required: true }];
  if (kind === "file") base.file = { accept: ["pdf", "png", "jpg"], maxSizeMb: 25, maxFiles: 5 };
  if (kind === "checklist") base.checklist = [{ key: "step_1", label: "First step", help: "" }];
  if (kind === "signature") base.signature = { provider: "External e-signature provider", instructions: "Sign using the link in the e-signature email." };
  if (kind === "task") base.assignee = { type: "onboarding_owner" };
  return base;
}

export function TemplateEditor({
  template,
  staff,
  readOnly,
}: {
  template: { id: string; name: string; description: string; category: string; content: TemplateContent; currentVersion: number };
  staff: { id: string; name: string }[];
  readOnly: boolean;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [category, setCategory] = useState(template.category);
  const [sections, setSections] = useState<Section[]>(template.content.sections);
  const [open, setOpen] = useState<string | null>(null);
  const [state, action, pending] = useActionState(saveTemplateAction, null);
  const [dirty, setDirty] = useState(false);

  const allItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const keys = useMemo(() => new Set(allItems.map((i) => i.key)), [allItems]);

  const update = (fn: (draft: Section[]) => void) => {
    const next = structuredClone(sections);
    fn(next);
    setSections(next);
    setDirty(true);
  };
  const updateItem = (si: number, ii: number, patch: Partial<TemplateItem>) =>
    update((d) => {
      d[si].items[ii] = { ...d[si].items[ii], ...patch };
    });
  const move = <T,>(arr: T[], from: number, to: number) => {
    if (to < 0 || to >= arr.length) return;
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
  };

  return (
    <form
      action={(fd) => {
        setDirty(false);
        return action(fd);
      }}
      className="space-y-5"
    >
      <input type="hidden" name="templateId" value={template.id} />
      <input type="hidden" name="content" value={JSON.stringify({ sections })} />
      <div className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <div>
            <label className="label" htmlFor="tpl-name">Template name</label>
            <input id="tpl-name" name="name" className="input text-base font-medium" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} disabled={readOnly} required />
          </div>
          <div>
            <label className="label" htmlFor="tpl-cat">Industry</label>
            <select id="tpl-cat" name="category" className="input" value={category} onChange={(e) => { setCategory(e.target.value); setDirty(true); }} disabled={readOnly}>
              <option value="agency">Marketing agency</option>
              <option value="accounting">Accounting</option>
              <option value="legal">Legal</option>
              <option value="consulting">Consulting</option>
              <option value="general">General</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="tpl-desc">Description</label>
          <textarea id="tpl-desc" name="description" className="input min-h-[60px]" value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} disabled={readOnly} />
        </div>
      </div>

      {sections.map((section, si) => (
        <section key={si} className="card">
          <div className="flex flex-col gap-2 border-b border-ink-100 p-4 sm:flex-row sm:items-center">
            <input
              className="input flex-1 font-semibold"
              value={section.title}
              onChange={(e) => update((d) => void (d[si].title = e.target.value))}
              disabled={readOnly}
              aria-label="Section title"
            />
            {!readOnly && (
              <div className="flex gap-1">
                <button type="button" className="btn-ghost p-2" onClick={() => update((d) => move(d, si, si - 1))} aria-label="Move section up"><ArrowUp className="h-4 w-4" /></button>
                <button type="button" className="btn-ghost p-2" onClick={() => update((d) => move(d, si, si + 1))} aria-label="Move section down"><ArrowDown className="h-4 w-4" /></button>
                <button
                  type="button"
                  className="btn-ghost p-2 text-rose-700"
                  onClick={() => confirm(`Delete section "${section.title}" and its items?`) && update((d) => void d.splice(si, 1))}
                  aria-label="Delete section"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          <ul className="divide-y divide-ink-100">
            {section.items.map((item, ii) => {
              const id = `${si}-${ii}`;
              const isOpen = open === id;
              return (
                <li key={id} className={clsx(isOpen && "bg-ink-50/60")}>
                  <button type="button" onClick={() => setOpen(isOpen ? null : id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.title}</span>
                      <span className="block text-xs text-ink-500">
                        {KIND_LABEL[item.kind]} · {item.audience === "internal" ? "Internal" : "Client"} · {item.required ? "Required" : "Optional"}
                        {item.dueOffsetDays != null && ` · due day ${item.dueOffsetDays}`}
                        {item.dependsOn?.length ? ` · after ${item.dependsOn.length} item${item.dependsOn.length > 1 ? "s" : ""}` : ""}
                      </span>
                    </span>
                    <span className="text-xs text-ink-400">{isOpen ? "Close" : readOnly ? "View" : "Edit"}</span>
                  </button>
                  {isOpen && (
                    <ItemEditor
                      item={item}
                      readOnly={readOnly}
                      staff={staff}
                      otherItems={allItems.filter((x) => x.key !== item.key)}
                      onChange={(patch) => updateItem(si, ii, patch)}
                      onMove={(dir) => { update((d) => move(d[si].items, ii, ii + dir)); setOpen(`${si}-${ii + dir}`); }}
                      onDelete={() => {
                        update((d) => {
                          d[si].items.splice(ii, 1);
                          for (const s of d) for (const it of s.items) if (it.dependsOn) it.dependsOn = it.dependsOn.filter((k) => k !== item.key);
                        });
                        setOpen(null);
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {!readOnly && (
            <div className="flex flex-wrap gap-1.5 border-t border-ink-100 p-3">
              <span className="self-center px-1 text-xs text-ink-500">Add:</span>
              {(Object.keys(KIND_LABEL) as TemplateItem["kind"][]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="btn-secondary px-2.5 py-1 text-xs"
                  onClick={() => {
                    update((d) => void d[si].items.push(newItem(k, keys)));
                    setOpen(`${si}-${section.items.length}`);
                  }}
                >
                  <Plus className="h-3 w-3" /> {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}

      {!readOnly && (
        <button
          type="button"
          className="btn-secondary w-full border-dashed py-3"
          onClick={() => update((d) => void d.push({ key: makeKey("section", new Set(d.map((s) => s.key))), title: "New section", items: [] }))}
        >
          <Plus className="h-4 w-4" /> Add section
        </button>
      )}

      {!readOnly && (
        <div className="sticky bottom-0 z-10 rounded-xl border border-ink-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-sm">
              {state?.error ? (
                <p className="font-medium text-rose-700">{state.error}</p>
              ) : state?.ok && !dirty ? (
                <p className="font-medium text-emerald-700">{state.ok}</p>
              ) : (
                <p className="text-ink-500">{dirty ? "Unsaved changes." : template.currentVersion ? `Published as v${template.currentVersion}.` : "Not published yet."}</p>
              )}
            </div>
            <input name="changeNote" className="input sm:w-56" placeholder="What changed? (optional)" aria-label="Change note" />
            <div className="flex gap-2">
              <button className="btn-secondary" name="publish" value="0" disabled={pending}>Save draft</button>
              <button className="btn-primary" name="publish" value="1" disabled={pending}>
                {pending ? "Saving…" : `Publish v${template.currentVersion + 1}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

function ItemEditor({
  item,
  readOnly,
  staff,
  otherItems,
  onChange,
  onMove,
  onDelete,
}: {
  item: TemplateItem;
  readOnly: boolean;
  staff: { id: string; name: string }[];
  otherItems: TemplateItem[];
  onChange: (patch: Partial<TemplateItem>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <fieldset disabled={readOnly} className="space-y-4 px-4 pb-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">Title</label>
          <input className="input" value={item.title} onChange={(e) => onChange({ title: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Instructions for the {item.audience === "internal" ? "team" : "client"}</label>
          <textarea className="input min-h-[60px]" value={item.description ?? ""} onChange={(e) => onChange({ description: e.target.value || undefined })} />
        </div>
        <div>
          <label className="label">Who it's for</label>
          <select className="input" value={item.audience} disabled={item.kind === "task"} onChange={(e) => onChange({ audience: e.target.value as "client" | "internal" })}>
            <option value="client">Client (shown in portal)</option>
            <option value="internal">Internal (team only)</option>
          </select>
        </div>
        <div>
          <label className="label">Due</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={365}
              className="input w-24"
              value={item.dueOffsetDays ?? ""}
              onChange={(e) => onChange({ dueOffsetDays: e.target.value === "" ? null : Number(e.target.value) })}
            />
            <span className="text-sm text-ink-500">days after start (blank for none)</span>
          </div>
        </div>
        <div>
          <label className="label">Assigned to</label>
          <select
            className="input"
            value={item.assignee?.type === "user" ? item.assignee.userId : item.assignee?.type ?? ""}
            onChange={(e) =>
              onChange({ assignee: e.target.value === "" ? null : e.target.value === "onboarding_owner" ? { type: "onboarding_owner" } : { type: "user", userId: e.target.value } })
            }
          >
            <option value="">{item.audience === "client" ? "The client (no staff owner)" : "Unassigned"}</option>
            <option value="onboarding_owner">The onboarding's owner</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="h-4 w-4 rounded" checked={item.required} onChange={(e) => onChange({ required: e.target.checked })} />
          Required to complete onboarding
        </label>
      </div>

      {otherItems.length > 0 && (
        <details className="rounded-lg border border-ink-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-medium">Depends on {item.dependsOn?.length ? `(${item.dependsOn.length})` : ""}</summary>
          <p className="mt-1 text-xs text-ink-500">This item is blocked until these are approved.</p>
          <div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
            {otherItems.map((o) => (
              <label key={o.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded"
                  checked={item.dependsOn?.includes(o.key) ?? false}
                  onChange={(e) => onChange({ dependsOn: e.target.checked ? [...(item.dependsOn ?? []), o.key] : (item.dependsOn ?? []).filter((k) => k !== o.key) })}
                />
                <span className="truncate">{o.title}</span>
              </label>
            ))}
          </div>
        </details>
      )}

      {item.kind === "form" && (
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <p className="mb-2 text-sm font-medium">Fields</p>
          <div className="space-y-2">
            {(item.fields ?? []).map((f, fi) => (
              <div key={fi} className="grid gap-2 rounded-md bg-ink-50 p-2 sm:grid-cols-[1fr_130px_auto_auto]">
                <input
                  className="input py-1.5 text-sm"
                  value={f.label}
                  placeholder="Question"
                  onChange={(e) => {
                    const fields = [...(item.fields ?? [])];
                    fields[fi] = { ...f, label: e.target.value };
                    onChange({ fields });
                  }}
                />
                <select
                  className="input py-1.5 text-sm"
                  value={f.type}
                  onChange={(e) => {
                    const fields = [...(item.fields ?? [])];
                    fields[fi] = { ...f, type: e.target.value as FormField["type"] };
                    onChange({ fields });
                  }}
                >
                  {FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => {
                      const fields = [...(item.fields ?? [])];
                      fields[fi] = { ...f, required: e.target.checked };
                      onChange({ fields });
                    }}
                  />
                  Required
                </label>
                <button type="button" className="btn-ghost p-1.5 text-rose-700" aria-label="Remove field" onClick={() => onChange({ fields: (item.fields ?? []).filter((_, i) => i !== fi) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
                {(f.type === "select" || f.type === "multiselect") && (
                  <input
                    className="input py-1.5 text-sm sm:col-span-4"
                    placeholder="Options, separated by commas"
                    value={(f.options ?? []).join(", ")}
                    onChange={(e) => {
                      const fields = [...(item.fields ?? [])];
                      fields[fi] = { ...f, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) };
                      onChange({ fields });
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2 px-2 py-1 text-xs"
            onClick={() => {
              const taken = new Set((item.fields ?? []).map((f) => f.key));
              onChange({ fields: [...(item.fields ?? []), { key: makeKey("field", taken), label: "", type: "text", required: false }] });
            }}
          >
            <Plus className="h-3 w-3" /> Add field
          </button>
          <p className="mt-2 text-xs text-ink-500">Fields that ask for passwords are rejected. Use the account-access checklist for delegated access instead.</p>
        </div>
      )}

      {item.kind === "file" && item.file && (
        <div className="grid gap-3 rounded-lg border border-ink-200 bg-white p-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label">Allowed file types</label>
            <input
              className="input"
              value={item.file.accept.join(", ")}
              onChange={(e) => onChange({ file: { ...item.file!, accept: e.target.value.split(",").map((s) => s.trim().replace(/^\./, "").toLowerCase()).filter(Boolean) } })}
            />
          </div>
          <div>
            <label className="label">Max size (MB)</label>
            <input type="number" min={1} max={100} className="input" value={item.file.maxSizeMb} onChange={(e) => onChange({ file: { ...item.file!, maxSizeMb: Number(e.target.value) } })} />
          </div>
          <div>
            <label className="label">Max files</label>
            <input type="number" min={1} max={20} className="input" value={item.file.maxFiles ?? ""} onChange={(e) => onChange({ file: { ...item.file!, maxFiles: e.target.value ? Number(e.target.value) : undefined } })} />
          </div>
        </div>
      )}

      {item.kind === "checklist" && (
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <p className="mb-2 text-sm font-medium">Steps</p>
          <div className="space-y-2">
            {(item.checklist ?? []).map((c, ci) => (
              <div key={ci} className="grid gap-2 rounded-md bg-ink-50 p-2 sm:grid-cols-[1fr_auto]">
                <input
                  className="input py-1.5 text-sm"
                  value={c.label}
                  placeholder="Step"
                  onChange={(e) => {
                    const list = [...(item.checklist ?? [])];
                    list[ci] = { ...c, label: e.target.value };
                    onChange({ checklist: list });
                  }}
                />
                <button type="button" className="btn-ghost p-1.5 text-rose-700" aria-label="Remove step" onClick={() => onChange({ checklist: (item.checklist ?? []).filter((_, i) => i !== ci) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
                <input
                  className="input py-1.5 text-sm sm:col-span-2"
                  value={c.help ?? ""}
                  placeholder="How to do it (e.g. where to add our team as a user)"
                  onChange={(e) => {
                    const list = [...(item.checklist ?? [])];
                    list[ci] = { ...c, help: e.target.value };
                    onChange({ checklist: list });
                  }}
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2 px-2 py-1 text-xs"
            onClick={() => {
              const taken = new Set((item.checklist ?? []).map((c) => c.key));
              onChange({ checklist: [...(item.checklist ?? []), { key: makeKey("step", taken), label: "", help: "" }] });
            }}
          >
            <Plus className="h-3 w-3" /> Add step
          </button>
        </div>
      )}

      {item.kind === "signature" && item.signature && (
        <div className="grid gap-3 rounded-lg border border-ink-200 bg-white p-3">
          <div>
            <label className="label">E-signature provider</label>
            <input className="input" value={item.signature.provider ?? ""} onChange={(e) => onChange({ signature: { ...item.signature!, provider: e.target.value } })} />
          </div>
          <div>
            <label className="label">Instructions</label>
            <textarea className="input" value={item.signature.instructions} onChange={(e) => onChange({ signature: { ...item.signature!, instructions: e.target.value } })} />
          </div>
          <p className="text-xs text-ink-500">This item tracks a signature collected in your e-signature tool. It is not itself a legally verified signature.</p>
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => onMove(-1)}><ArrowUp className="h-3 w-3" /> Up</button>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => onMove(1)}><ArrowDown className="h-3 w-3" /> Down</button>
          <button type="button" className="btn-danger px-2.5 py-1 text-xs" onClick={() => confirm(`Delete "${item.title}"?`) && onDelete()}><Trash2 className="h-3 w-3" /> Delete item</button>
        </div>
      )}
    </fieldset>
  );
}
