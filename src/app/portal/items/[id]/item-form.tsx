"use client";

import { useActionState } from "react";
import type { FormField } from "@/lib/templates";
import { SubmitButton } from "@/components/forms";
import { saveItemAction } from "../../actions";

interface Props {
  itemId: string;
  kind: string;
  config: {
    fields?: FormField[];
    checklist?: { key: string; label: string; help?: string }[];
    signature?: { provider?: string; instructions: string };
  };
  response: Record<string, unknown>;
  locked: boolean;
  brandColor: string;
  hasFiles: boolean;
}

export function ItemForm({ itemId, kind, config, response, locked, brandColor, hasFiles }: Props) {
  const [state, action] = useActionState(saveItemAction, null);
  const checked = new Set((response.checked as string[] | undefined) ?? []);
  const notes = (response.notes as Record<string, string> | undefined) ?? {};

  if (kind === "file" && locked) return null;

  return (
    <form action={action} className="card" noValidate>
      <input type="hidden" name="itemId" value={itemId} />
      <fieldset disabled={locked} className="space-y-5 p-5">
        {kind === "form" &&
          (config.fields ?? []).map((f) => <Field key={f.key} field={f} value={response[f.key]} />)}

        {kind === "checklist" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-ink-50 p-3 text-sm text-ink-600">
              Give our team its own access using each platform's sharing settings. Never type a password here.
            </div>
            {(config.checklist ?? []).map((c) => (
              <div key={c.key} className="rounded-lg border border-ink-200 p-4">
                <label className="flex items-start gap-3">
                  <input type="checkbox" name="checked" value={c.key} defaultChecked={checked.has(c.key)} className="mt-0.5 h-5 w-5 rounded border-ink-300" style={{ accentColor: brandColor }} />
                  <span>
                    <span className="block font-medium">{c.label}</span>
                    {c.help && <span className="mt-1 block text-sm text-ink-500">{c.help}</span>}
                  </span>
                </label>
                <input name={`note_${c.key}`} defaultValue={notes[c.key] ?? ""} className="input mt-3 text-sm" placeholder="Note for the team (optional)" maxLength={1000} />
              </div>
            ))}
          </div>
        )}

        {kind === "question" && (
          <div>
            <label className="label" htmlFor="answer">Your answer</label>
            <textarea id="answer" name="answer" className="input min-h-[140px]" defaultValue={(response.answer as string) ?? ""} />
          </div>
        )}

        {kind === "signature" && (
          <div className="space-y-3">
            <div className="rounded-lg bg-ink-50 p-4 text-sm text-ink-700">
              <p>{config.signature?.instructions}</p>
              <p className="mt-2 text-xs text-ink-500">
                The signature itself happens in {config.signature?.provider ?? "the e-signature tool"}. Submitting here only tells the team you've signed; it is not a signature.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="client_note">Note for the team (optional)</label>
              <input id="client_note" name="client_note" className="input" defaultValue={(response.client_note as string) ?? ""} placeholder="e.g. Signed on Monday" />
            </div>
          </div>
        )}

        {kind === "file" && <p className="text-sm text-ink-600">{hasFiles ? "When you've uploaded everything, submit it for review." : "Upload your files above, then submit them for review."}</p>}
      </fieldset>
      {!locked && (
        <div className="flex flex-col-reverse gap-2 border-t border-ink-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm" aria-live="polite">
            {state?.error && <p className="font-medium text-rose-700">{state.error}</p>}
            {state?.ok && <p className="font-medium text-emerald-700">{state.ok}</p>}
          </div>
          <div className="flex gap-2">
            {kind !== "file" && kind !== "signature" && (
              <SubmitButton className="btn-secondary flex-1 py-2.5 sm:flex-none" name="intent" value="save" pendingText="Saving…">Save progress</SubmitButton>
            )}
            <button type="submit" name="intent" value="submit" className="btn flex-1 py-2.5 text-white shadow-sm sm:flex-none" style={{ background: brandColor }}>
              {kind === "signature" ? "I've signed it" : "Submit for review"}
            </button>
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
    return <div>{label}<textarea id={id} name={id} className="input min-h-[110px]" defaultValue={str} maxLength={5000} />{help}</div>;
  if (f.type === "select")
    return (
      <div>
        {label}
        <select id={id} name={id} className="input" defaultValue={str}>
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
            <label key={o} className="flex items-center gap-2 rounded-lg border border-ink-200 px-3 py-2.5 text-sm">
              <input type="checkbox" name={id} value={o} defaultChecked={selected.has(o)} className="h-4 w-4 rounded" /> {o}
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
      <input id={id} name={id} type={type} className="input" defaultValue={str} inputMode={f.type === "phone" ? "tel" : undefined} autoComplete="off" />
      {help}
    </div>
  );
}
