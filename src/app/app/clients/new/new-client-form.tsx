"use client";

import Link from "next/link";
import { useActionState } from "react";
import { SubmitButton } from "@/components/forms";
import { createClientAction } from "../../actions";
import { CopyLink } from "@/components/copy-link";

export function NewClientForm({
  templates,
  staff,
  defaultOwner,
  timezones,
  defaultTimezone,
  isDemo,
}: {
  templates: { id: string; name: string; current_version: number }[];
  staff: { id: string; name: string }[];
  defaultOwner: string;
  timezones: string[];
  defaultTimezone: string;
  isDemo: boolean;
}) {
  const [state, action] = useActionState(createClientAction, null);
  const data = state?.data as { clientId: string; inviteUrl: string | null; emailStatus: string | null } | undefined;

  if (state?.ok && data) {
    return (
      <div className="card max-w-2xl p-6">
        <h2 className="text-lg font-semibold">{state.ok}</h2>
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
        <Link href={`/app/clients/${data.clientId}`} className="btn-primary mt-6">Open client</Link>
      </div>
    );
  }

  return (
    <form action={action} className="card max-w-3xl divide-y divide-ink-100">
      <fieldset className="grid gap-4 p-6 sm:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Company</legend>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="name">Client name</label>
          <input id="name" name="name" className="input" required maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="industry">Industry</label>
          <input id="industry" name="industry" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="website">Website</label>
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
          <select id="ownerId" name="ownerId" className="input" defaultValue={defaultOwner}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </fieldset>
      <fieldset className="grid gap-4 p-6 sm:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Onboarding</legend>
        <div>
          <label className="label" htmlFor="templateId">Template</label>
          <select id="templateId" name="templateId" className="input">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.current_version})</option>)}
            <option value="">Don't start an onboarding yet</option>
          </select>
          <p className="mt-1 text-xs text-ink-500">The client gets a copy of the current version. Later template edits won't change it.</p>
        </div>
        <div>
          <label className="label" htmlFor="startDate">Start date</label>
          <input id="startDate" name="startDate" type="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} />
          <p className="mt-1 text-xs text-ink-500">Due dates are calculated from this date.</p>
        </div>
      </fieldset>
      <fieldset className="grid gap-4 p-6 sm:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold sm:col-span-2">Main contact</legend>
        <div>
          <label className="label" htmlFor="contactName">Name</label>
          <input id="contactName" name="contactName" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="contactEmail">Email</label>
          <input id="contactEmail" name="contactEmail" type="email" className="input" />
        </div>
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="invite" defaultChecked className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600" />
          <span>
            Invite them to the client portal now
            <span className="block text-xs text-ink-500">
              Single-use link, expires in 7 days.{isDemo ? " Demo workspace: the email is recorded, not sent." : ""}
            </span>
          </span>
        </label>
      </fieldset>
      <div className="flex items-center justify-between gap-3 p-6">
        {state?.error ? <p className="text-sm font-medium text-rose-700">{state.error}</p> : <span />}
        <SubmitButton pendingText="Creating…">Create client</SubmitButton>
      </div>
    </form>
  );
}
