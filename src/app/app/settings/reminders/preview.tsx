"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/forms";
import { previewRuleAction } from "../../actions";

export function PreviewButton({ ruleId }: { ruleId: string }) {
  const [state, action] = useActionState(previewRuleAction, null);
  const data = state?.data as { subject: string; body: string; sampleClient: string; timeZone: string } | undefined;
  return (
    <form action={action} className="contents">
      <input type="hidden" name="ruleId" value={ruleId} />
      <SubmitButton className="btn-secondary" pendingText="Rendering…">Preview</SubmitButton>
      {state?.error && <p className="w-full text-sm text-rose-700">{state.error}</p>}
      {data && (
        <div className="order-last w-full rounded-lg border border-brand-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Preview using {data.sampleClient} ({data.timeZone})</p>
          <p className="mt-2 font-medium">{data.subject}</p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-ink-700">{data.body}</pre>
        </div>
      )}
    </form>
  );
}
