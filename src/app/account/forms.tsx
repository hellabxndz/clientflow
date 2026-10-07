"use client";

import { useActionState } from "react";
import { SubmitButton, type FormAction } from "@/components/forms";

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-semibold text-amber-900">Save these recovery codes now</p>
      <p className="mt-1 text-sm text-amber-800">Each works once if you lose your phone. They won't be shown again.</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="rounded bg-white px-2 py-1 text-center">{c}</li>
        ))}
      </ul>
      <button type="button" className="btn-secondary mt-3 px-3 py-1.5 text-xs" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>
        Copy codes
      </button>
    </div>
  );
}

/** A form whose success can carry one-time recovery codes. */
export function CodeForm({
  action,
  label,
  button,
  pending,
  done,
}: {
  action: FormAction;
  label: string;
  button: string;
  pending: string;
  done?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const codes = (state?.data as { codes?: string[] } | undefined)?.codes;
  if (codes)
    return (
      <div>
        <p role="status" className="text-sm font-medium text-emerald-700">{state?.ok}</p>
        <RecoveryCodes codes={codes} />
        {done && (
          <a href="/" className="btn-primary mt-4 inline-flex px-4 py-2">{done}</a>
        )}
      </div>
    );
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="label" htmlFor={`code-${button}`}>{label}</label>
        <input id={`code-${button}`} name="code" className="input max-w-[12rem] text-center font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
      </div>
      <SubmitButton className="btn-primary" pendingText={pending}>{button}</SubmitButton>
      {state?.error && <p role="alert" className="text-sm font-medium text-rose-700">{state.error}</p>}
    </form>
  );
}
