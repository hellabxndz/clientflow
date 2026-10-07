"use client";

import { useActionState } from "react";
import { Bot, Sparkles } from "lucide-react";
import { SubmitButton, ActionForm } from "@/components/forms";
import { aiAssistAction, sendManualMessageAction } from "../../actions";

type Result = { source: "ai" | "rules"; text: string; flags?: string[]; note?: string; kind: string };

export function AiPanel({
  onboardingId,
  aiAvailable,
  aiReason,
  emailMode,
  labels,
}: {
  onboardingId: string;
  aiAvailable: boolean;
  aiReason: string;
  emailMode: string;
  labels: Record<string, string>;
}) {
  const [state, action] = useActionState(aiAssistAction, null);
  const result = state?.data as Result | undefined;
  return (
    <div>
      <div className={aiAvailable ? "mb-3 flex items-start gap-2 text-xs text-ink-500" : "mb-3 flex items-start gap-2 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600"}>
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{aiAvailable ? `AI assistance on. ${aiReason}` : aiReason}</span>
      </div>
      <form action={action} className="flex flex-wrap gap-1.5">
        <input type="hidden" name="onboardingId" value={onboardingId} />
        {Object.entries(labels).map(([kind, label]) => (
          <SubmitButton key={kind} className="btn-secondary px-2.5 py-1 text-xs" name="kind" value={kind} pendingText="Working…">
            {label}
          </SubmitButton>
        ))}
      </form>
      {state?.error && <p className="mt-3 text-sm text-rose-700">{state.error}</p>}
      {result && (
        <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            {result.source === "ai" ? <Sparkles className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
            {labels[result.kind] ?? "Result"} ·{" "}
            {result.source === "ai" ? "AI draft, review before using" : aiAvailable ? "Generated from onboarding records" : "Generated from onboarding records (AI not configured)"}
          </p>
          {result.note && <p className="mb-2 text-xs text-ink-500">{result.note}</p>}
          {result.kind === "flags" ? (
            result.flags && result.flags.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {result.flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">No missing information spotted. A person still needs to review each item.</p>
            )
          ) : result.kind === "reminder" ? (
            <ActionForm action={sendManualMessageAction} className="space-y-2">
              <input type="hidden" name="onboardingId" value={onboardingId} />
              <input name="subject" className="input" defaultValue="A quick update on your onboarding" aria-label="Subject" />
              <textarea name="body" className="input min-h-[220px] text-sm" defaultValue={result.text} aria-label="Message" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-500">
                  {emailMode === "demo"
                    ? "Demo workspace: recorded in the outbox, never actually sent."
                    : emailMode === "not_configured"
                      ? "Email isn't configured; sending will be logged as failed."
                      : "Edit, then send to the client's main contact."}
                </p>
                <SubmitButton pendingText="Sending…">Send</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink-800">{result.text}</p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">Suggestions only. AI never approves items, documents or onboardings.</p>
    </div>
  );
}
