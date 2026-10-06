"use client";

import { useActionState } from "react";
import { Sparkles } from "lucide-react";
import { SubmitButton, ActionForm } from "@/components/forms";
import { aiAssistAction, sendManualMessageAction } from "../../actions";

type Result = { source: "ai" | "rules"; text: string; flags?: string[]; note?: string; kind: string };

export function AiPanel({ onboardingId, aiAvailable, aiReason, emailMode }: { onboardingId: string; aiAvailable: boolean; aiReason: string; emailMode: string }) {
  const [state, action] = useActionState(aiAssistAction, null);
  const result = state?.data as Result | undefined;
  return (
    <div>
      <form action={action} className="flex flex-wrap gap-2">
        <input type="hidden" name="onboardingId" value={onboardingId} />
        <SubmitButton className="btn-secondary" name="kind" value="summary" pendingText="Working…">Summarize progress</SubmitButton>
        <SubmitButton className="btn-secondary" name="kind" value="flags" pendingText="Working…">Flag missing info</SubmitButton>
        <SubmitButton className="btn-secondary" name="kind" value="reminder" pendingText="Working…">Draft reminder</SubmitButton>
      </form>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
        <Sparkles className="h-3.5 w-3.5" /> {aiAvailable ? `AI assistance on. ${aiReason}` : aiReason}
      </p>
      {state?.error && <p className="mt-3 text-sm text-rose-700">{state.error}</p>}
      {result && (
        <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {result.source === "ai" ? "AI draft · review before using" : "Rule-based result"}
          </p>
          {result.note && <p className="mb-2 text-xs text-ink-500">{result.note}</p>}
          {result.kind === "flags" ? (
            result.flags && result.flags.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {result.flags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            ) : (
              <p className="text-sm">No missing information spotted. A person still needs to review each item.</p>
            )
          ) : result.kind === "reminder" ? (
            <ActionForm action={sendManualMessageAction} className="space-y-2">
              <input type="hidden" name="onboardingId" value={onboardingId} />
              <input name="subject" className="input" defaultValue="A quick update on your onboarding" aria-label="Subject" />
              <textarea name="body" className="input min-h-[220px] text-sm" defaultValue={result.text} aria-label="Message" />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-ink-500">{emailMode === "demo" ? "Demo: will be recorded in the outbox, not sent." : emailMode === "not_configured" ? "Email isn't configured; sending will be logged as failed." : "Edit, then send to the client's main contact."}</p>
                <SubmitButton pendingText="Sending…">Send</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed">{result.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
