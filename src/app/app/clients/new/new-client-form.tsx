"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
import { createClientAction } from "./actions";

export interface ClientTypeOption {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  default_owner_user_id: string | null;
}

export function NewClientForm({
  templates,
  staff,
  clientTypes,
  defaultOwner,
  timezones,
  defaultTimezone,
  isDemo,
}: {
  templates: { id: string; name: string; current_version: number }[];
  staff: { id: string; name: string }[];
  clientTypes: ClientTypeOption[];
  defaultOwner: string;
  timezones: string[];
  defaultTimezone: string;
  isDemo: boolean;
}) {
  const [state, action, pending] = useActionState(createClientAction, null);
  const [typeId, setTypeId] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState(defaultOwner);
  const data = state?.data as { clientId: string; onboardingId: string | null; inviteUrl: string | null; emailStatus: string | null } | undefined;
  const selectedType = clientTypes.find((t) => t.id === typeId);

  function chooseType(id: string) {
    setTypeId(id);
    const t = clientTypes.find((x) => x.id === id);
    if (t?.template_id && templates.some((x) => x.id === t.template_id)) setTemplateId(t.template_id);
    if (t?.default_owner_user_id && staff.some((s) => s.id === t.default_owner_user_id)) setOwnerId(t.default_owner_user_id);
  }

  if (state?.ok && data) {
    return (
      <div className="card max-w-2xl p-6">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <h2 className="text-lg font-semibold">{state.ok}</h2>
        </div>
        <p className="mt-1 text-sm text-ink-600">{data.onboardingId ? "Their onboarding has started from the template you chose." : "No onboarding was started. You can start one from the client page."}</p>
        {data.inviteUrl ? (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-ink-600">
              {data.emailStatus === "sent"
                ? "We emailed the invitation. You can also share this single-use link directly:"
                : data.emailStatus === "simulated"
                  ? "Demo workspace: the invitation email was recorded in the outbox, not sent. Share this single-use link to try the portal:"
                  : "Email isn't configured, so share this single-use link with the client yourself:"}
            </p>
            <CopyLink url={data.inviteUrl} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-600">No invitation was sent. You can invite contacts from the client page.</p>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          <Link href={`/app/clients/${data.clientId}`} className="btn-primary">Open client</Link>
          <a href="/app/clients/new" className="btn-secondary">Add another client</a>
        </div>
      </div>
    );
  }

  return (
    <form
      className="card max-w-3xl divide-y divide-ink-100"
      onSubmit={(e) => {
        // Submit manually so the form keeps what was typed when the server returns an error.
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <fieldset className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Company</legend>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="name">Client name</label>
          <input id="name" name="name" className="input" required maxLength={200} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="clientTypeId">Client type</label>
          <select id="clientTypeId" name="clientTypeId" className="input" value={typeId} onChange={(e) => chooseType(e.target.value)}>
            <option value="">No client type</option>
            {clientTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">
            {selectedType
              ? selectedType.description ?? "Choosing a client type selects its default template and owner. You can change both below."
              : clientTypes.length
                ? "Choosing a client type selects its default template and owner."
                : "Managers can set up client types (service lines) with a default template and owner in Settings."}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="industry">Industry <span className="font-normal text-ink-400">(optional)</span></label>
          <input id="industry" name="industry" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="website">Website <span className="font-normal text-ink-400">(optional)</span></label>
          <input id="website" name="website" type="url" className="input" placeholder="https://" />
        </div>
        <div>
          <label className="label" htmlFor="timezone">Client time zone</label>
          <select id="timezone" name="timezone" className="input" defaultValue={defaultTimezone}>
            {timezones.map((tz) => <option key={tz}>{tz}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-500">Reminders go out in the client's local time.</p>
        </div>
        <div>
          <label className="label" htmlFor="ownerId">Account owner</label>
          <select id="ownerId" name="ownerId" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Contract <span className="font-normal text-ink-400">(optional)</span></legend>
        <div>
          <label className="label" htmlFor="dealAmount">Contract value (USD)</label>
          <input id="dealAmount" name="dealAmount" inputMode="decimal" className="input" placeholder="e.g. 4500" pattern="[$]?[0-9,]*(\.[0-9]{1,2})?" />
        </div>
        <div>
          <label className="label" htmlFor="dealRecurrence">Billed</label>
          <select id="dealRecurrence" name="dealRecurrence" className="input" defaultValue="monthly">
            <option value="monthly">Monthly</option>
            <option value="annual">Annually</option>
            <option value="one_time">One time</option>
          </select>
        </div>
        <p className="text-xs text-ink-500 sm:col-span-2">Signed contract value. It appears as Contract Value in Active Onboarding until the client is ready for kickoff.</p>
      </fieldset>

      <fieldset className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Onboarding</legend>
        <div>
          <label className="label" htmlFor="templateId">Template</label>
          <select id="templateId" name="templateId" className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.current_version})</option>)}
            <option value="">Don't start an onboarding yet</option>
          </select>
          <p className="mt-1 text-xs text-ink-500">The client gets a copy of the current version. Later template edits won't change it.</p>
        </div>
        <div>
          <label className="label" htmlFor="startDate">Start date</label>
          <input id="startDate" name="startDate" type="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} suppressHydrationWarning />
          <p className="mt-1 text-xs text-ink-500">Due dates are calculated from this date.</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Main contact <span className="font-normal text-ink-400">(optional)</span></legend>
        <div>
          <label className="label" htmlFor="contactName">Name</label>
          <input id="contactName" name="contactName" className="input" autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="contactEmail">Email</label>
          <input id="contactEmail" name="contactEmail" type="email" className="input" autoComplete="off" />
        </div>
        <div>
          <label className="label" htmlFor="contactTitle">Job title</label>
          <input id="contactTitle" name="contactTitle" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="contactPhone">Phone</label>
          <input id="contactPhone" name="contactPhone" type="tel" className="input" />
        </div>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="invite" defaultChecked className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600" />
          <span>
            Invite them to the client portal now
            <span className="block text-xs text-ink-500">
              Single-use link, expires in 7 days. Needs an email address.{isDemo ? " Demo workspace: the email is recorded, not sent." : ""}
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-col-reverse gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        {state?.error ? <p className="text-sm font-medium text-rose-700" role="alert">{state.error}</p> : <span />}
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create client"}
        </button>
      </div>
    </form>
  );
}
