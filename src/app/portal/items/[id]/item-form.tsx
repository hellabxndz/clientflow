"use client";

import { useActionState } from "react";
import type { FormField } from "@/lib/templates";
import { SubmitButton } from "@/components/forms";
import { saveItemAction } from "../../actions";

export interface ItemConfig {
  fields?: FormField[];
  checklist?: { key: string; label: string; help?: string }[];
  file?: { accept: string[]; maxSizeMb: number; maxFiles?: number };
  signature?: { provider?: string; instructions: string };
  access?: { platform: string; instructions: string; inviteEmail?: string; accessLevel?: string; helpUrl?: string; accountIdLabel?: string };
}

interface Props {
  itemId: string;
  kind: string;
  config: ItemConfig;
  response: Record<string, unknown>;
  locked: boolean;
  hasFiles: boolean;
  status: string;
}

type FormState = Awaited<ReturnType<typeof saveItemAction>> & { draft?: Record<string, unknown>; attempt?: number };

/** What the client typed, in the same shape as a saved response, so a rejected submit doesn't wipe their answers. */
function draftFrom(fd: FormData, kind: string, config: ItemConfig): Record<string, unknown> {
  const text = (k: string) => String(fd.get(k) ?? "");
  if (kind === "form") {
    const out: Record<string, unknown> = {};
    for (const f of config.fields ?? []) out[f.key] = f.type === "multiselect" ? fd.getAll(`f_${f.key}`).map(String) : text(`f_${f.key}`);
    return out;
  }
  if (kind === "checklist") {
    const notes: Record<string, string> = {};
    for (const c of config.checklist ?? []) notes[c.key] = text(`note_${c.key}`);
    return { checked: fd.getAll("checked").map(String), notes };
  }
  if (kind === "access") return { accountId: text("accountId"), confirmed: fd.get("confirmed") === "on", note: text("note") };
  if (kind === "question") return { answer: text("answer") };
  if (kind === "signature") return { client_note: text("client_note") };
  return {};
}

export function ItemForm({ itemId, kind, config, response: saved, locked, hasFiles, status }: Props) {
  // React resets a form after its action runs; on an error, re-render with what the client typed.
  const [state, action] = useActionState(async (prev: FormState | null, fd: FormData): Promise<FormState> => {
    const result = await saveItemAction(prev, fd);
    return { ...result, attempt: (prev?.attempt ?? 0) + 1, draft: result?.error ? draftFrom(fd, kind, config) : undefined };
  }, null);
  const response = state?.draft ?? saved;
  const checked = new Set((response.checked as string[] | undefined) ?? []);
  const notes = (response.notes as Record<string, string> | undefined) ?? {};

  if (kind === "file" && locked) return null;
  const resubmit = status === "changes_requested" || status === "submitted";
  const submitLabel = kind === "signature" ? "I've signed it" : kind === "access" ? (resubmit ? "Resubmit" : "Done, notify the team") : resubmit ? "Resubmit" : "Submit";

  return (
    <form action={action} className="card" noValidate>
      <input type="hidden" name="itemId" value={itemId} />
      <fieldset key={state?.attempt ?? 0} disabled={locked} className="space-y-5 p-5">
        {kind === "form" && (config.fields ?? []).map((f) => <Field key={f.key} field={f} value={response[f.key]} />)}

        {kind === "checklist" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-ink-50 p-3 text-sm text-ink-600">
              Give our team its own access using each platform's sharing settings. Never type a password here.
            </div>
            {(config.checklist ?? []).map((c) => (
              <div key={c.key} className="rounded-lg border border-ink-200 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" name="checked" value={c.key} defaultChecked={checked.has(c.key)} className="mt-0.5 h-6 w-6 shrink-0 rounded border-ink-300" style={{ accentColor: "var(--brand)" }} />
                  <span>
                    <span className="block font-medium text-ink-900">{c.label}</span>
                    {c.help && <span className="mt-1 block whitespace-pre-line text-sm text-ink-500">{c.help}</span>}
                  </span>
                </label>
                <input name={`note_${c.key}`} defaultValue={notes[c.key] ?? ""} className="input mt-3 text-[15px]" placeholder="Note for the team (optional)" maxLength={1000} autoComplete="off" />
              </div>
            ))}
          </div>
        )}

        {kind === "access" && (
          <div className="space-y-4">
            {config.access?.accountIdLabel && (
              <div>
                <label className="label" htmlFor="accountId">{config.access.accountIdLabel} <span className="font-normal text-ink-400">(optional)</span></label>
                <input id="accountId" name="accountId" className="input text-[15px]" defaultValue={(response.accountId as string) ?? ""} maxLength={120} autoComplete="off" spellCheck={false} />
              </div>
            )}
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-4">
              <input type="checkbox" name="confirmed" defaultChecked={response.confirmed === true} className="mt-0.5 h-6 w-6 shrink-0 rounded border-ink-300" style={{ accentColor: "var(--brand)" }} />
              <span>
                <span className="block font-medium text-ink-900">I've sent the invitation</span>
                <span className="mt-0.5 block text-sm text-ink-500">Tick this once you've followed the steps above.</span>
              </span>
            </label>
            <div>
              <label className="label" htmlFor="note">Note for the team <span className="font-normal text-ink-400">(optional)</span></label>
              <textarea id="note" name="note" className="input min-h-[80px] text-[15px]" defaultValue={(response.note as string) ?? ""} maxLength={1000} placeholder="e.g. Sent from our marketing@ account, or tell us where you got stuck" />
              <p className="mt-1 text-xs text-ink-500">Never type a password here. We only need the invitation.</p>
            </div>
          </div>
        )}

        {kind === "question" && (
          <div>
            <label className="label" htmlFor="answer">Your answer</label>
            <textarea id="answer" name="answer" className="input min-h-[140px] text-[15px]" defaultValue={(response.answer as string) ?? ""} maxLength={5000} />
          </div>
        )}

        {kind === "signature" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-ink-50 p-4 text-sm text-ink-700">
              <p className="whitespace-pre-line">{config.signature?.instructions}</p>
              <p className="mt-2 text-xs text-ink-500">
                The signature itself happens in {config.signature?.provider ?? "the e-signature tool"}. Submitting here only tells the team you've signed; it is not a signature.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="client_note">Note for the team (optional)</label>
              <input id="client_note" name="client_note" className="input text-[15px]" defaultValue={(response.client_note as string) ?? ""} placeholder="e.g. Signed on Monday" />
            </div>
          </div>
        )}

        {kind === "file" && (
          <p className="text-sm text-ink-600">{hasFiles ? "When you've uploaded everything, submit it for review." : "Upload your files above, then submit them for review."}</p>
        )}
      </fieldset>
      {!locked && (
        <div className="sticky bottom-0 z-10 flex flex-col-reverse gap-2 rounded-b-xl border-t border-ink-100 bg-white/95 p-4 backdrop-blur sm:static sm:flex-row sm:items-center sm:justify-between sm:bg-transparent">
          <div className="text-sm" aria-live="polite">
            {state?.error && <p className="font-medium text-rose-700">{state.error}</p>}
            {state?.ok && <p className="font-medium text-emerald-700">{state.ok}</p>}
          </div>
          <div className="flex gap-2">
            {kind !== "file" && kind !== "signature" && (
              <SubmitButton className="btn-secondary min-h-[48px] flex-1 sm:min-h-0 sm:flex-none sm:py-2.5" name="intent" value="save" pendingText="Saving…">
                Save progress
              </SubmitButton>
            )}
            <SubmitButton
              className="btn min-h-[48px] flex-1 font-semibold text-white shadow-sm sm:min-h-0 sm:flex-none sm:py-2.5 [background:var(--brand)] hover:opacity-95"
              name="intent"
              value="submit"
              pendingText="Submitting…"
            >
              {submitLabel}
            </SubmitButton>
          </div>
        </div>
      )}
    </form>
  );
}

function Field({ field: f, value }: { field: FormField; value: unknown }) {
  const id = `f_${f.key}`;
  const label = (
    <label className="label" htmlFor={id}>
      {f.label}
      {f.required ? <span className="text-rose-600"> *</span> : <span className="font-normal text-ink-400"> (optional)</span>}
    </label>
  );
  const str = typeof value === "string" ? value : "";
  const help = f.help ? <p className="mt-1 text-xs text-ink-500">{f.help}</p> : null;
  if (f.type === "textarea")
    return <div>{label}<textarea id={id} name={id} className="input min-h-[110px] text-[15px]" defaultValue={str} maxLength={5000} />{help}</div>;
  if (f.type === "select")
    return (
      <div>
        {label}
        <select id={id} name={id} className="input text-[15px]" defaultValue={str}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => <option key={o}>{o}</option>)}
        </select>
        {help}
      </div>
    );
  if (f.type === "multiselect") {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
    return (
      <fieldset>
        <legend className="label">{f.label}{f.required && <span className="text-rose-600"> *</span>}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-ink-200 px-3 py-2.5 text-sm">
              <input type="checkbox" name={id} value={o} defaultChecked={selected.has(o)} className="h-5 w-5 rounded" style={{ accentColor: "var(--brand)" }} /> {o}
            </label>
          ))}
        </div>
        {help}
      </fieldset>
    );
  }
  const type = f.type === "phone" ? "tel" : f.type === "url" ? "url" : f.type === "email" ? "email" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
  return (
    <div>
      {label}
      <input id={id} name={id} type={type} className="input text-[15px]" defaultValue={str} inputMode={f.type === "phone" ? "tel" : undefined} autoComplete="off" />
      {help}
    </div>
  );
}
