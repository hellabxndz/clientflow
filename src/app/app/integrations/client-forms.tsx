"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/forms";
import { generateSigningSecretAction, simulateDealAction } from "./actions";

function Result({ state }: { state: { ok?: string; error?: string } | null }) {
  if (state?.error)
    return (
      <p role="alert" className="mt-2 text-sm font-medium text-rose-700">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="mt-2 text-sm font-medium text-emerald-700">
        {state.ok}
      </p>
    );
  return null;
}

export function SecretGenerator({ provider, hasSecret }: { provider: string; hasSecret: boolean }) {
  const [state, action] = useActionState(generateSigningSecretAction, null);
  const [copied, setCopied] = useState(false);
  const secret = (state?.data as { secret?: string } | undefined)?.secret;
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (hasSecret && !window.confirm("Replace the current signing secret? Senders using the old one will be rejected until updated.")) e.preventDefault();
      }}
    >
      <input type="hidden" name="provider" value={provider} />
      <SubmitButton className="btn-secondary" pendingText="Generating…">
        {hasSecret ? "Rotate signing secret" : "Generate signing secret"}
      </SubmitButton>
      <Result state={state} />
      {secret && (
        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
          <code className="min-w-0 flex-1 break-all text-xs text-ink-900">{secret}</code>
          <button
            type="button"
            className="btn-ghost shrink-0 px-2 py-1 text-xs"
            onClick={() => {
              navigator.clipboard?.writeText(secret).then(() => setCopied(true), () => {});
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </form>
  );
}

export function SimulateDealForm({ clientTypes }: { clientTypes: string[] }) {
  const [state, action] = useActionState(simulateDealAction, null);
  const clientId = (state?.data as { clientId?: string } | undefined)?.clientId;
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="label">Company</span>
          <input name="company" className="input" required maxLength={200} placeholder="e.g. Harbor Coffee Co." />
        </label>
        <label className="block min-w-0">
          <span className="label">Pretend it came from</span>
          <select name="provider" className="input" defaultValue="hubspot">
            <option value="hubspot">HubSpot</option>
            <option value="salesforce">Salesforce</option>
            <option value="pipedrive">Pipedrive</option>
          </select>
        </label>
        <label className="block min-w-0">
          <span className="label">Contact name</span>
          <input name="contactName" className="input" maxLength={200} />
        </label>
        <label className="block min-w-0">
          <span className="label">Contact email</span>
          <input name="contactEmail" type="email" className="input" maxLength={200} placeholder="name@example.com" />
        </label>
        <label className="block min-w-0">
          <span className="label">Service type</span>
          <select name="serviceType" className="input" defaultValue={clientTypes[0] ?? ""}>
            <option value="">None (no workflow chosen)</option>
            {clientTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className="label">Amount (USD)</span>
            <input name="amount" type="number" min={0} step="any" className="input" defaultValue={5000} />
          </label>
          <label className="block min-w-0">
            <span className="label">Billing</span>
            <select name="recurrence" className="input" defaultValue="monthly">
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
              <option value="one_time">One-time</option>
            </select>
          </label>
        </div>
      </div>
      <SubmitButton pendingText="Simulating…">Simulate closed-won deal</SubmitButton>
      <Result state={state} />
      {clientId && (
        <Link href={`/app/clients/${clientId}`} className="link inline-block text-sm">
          Open the client →
        </Link>
      )}
    </form>
  );
}
