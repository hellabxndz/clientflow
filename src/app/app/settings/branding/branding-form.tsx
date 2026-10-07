"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { updateBrandingAction } from "./actions";

export interface BrandingValues {
  name: string;
  brandColor: string;
  accentColor: string;
  portalWelcome: string;
  emailFromName: string;
  portalName: string;
  supportEmail: string;
  supportPhone: string;
  logoUrl: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={HEX.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-ink-200 bg-white p-1"
        />
        <input id={id} name={id} className="input font-mono" value={value} onChange={(e) => onChange(e.target.value)} pattern="#[0-9a-fA-F]{6}" maxLength={7} required />
      </div>
      {!HEX.test(value) && <p className="mt-1 text-xs text-rose-700">Use a 6-digit hex value like #7647e8.</p>}
    </div>
  );
}

export function BrandingForm({ initial, canEdit }: { initial: BrandingValues; canEdit: boolean }) {
  const [v, setV] = useState(initial);
  const set = (k: keyof BrandingValues) => (val: string) => setV((s) => ({ ...s, [k]: val }));
  const brand = HEX.test(v.brandColor) ? v.brandColor : initial.brandColor;
  const accent = HEX.test(v.accentColor) ? v.accentColor : initial.accentColor;
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <ActionForm action={updateBrandingAction} className="xl:col-span-3">
        <fieldset disabled={!canEdit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">Company name</label>
              <input id="name" name="name" className="input" value={v.name} onChange={(e) => set("name")(e.target.value)} maxLength={120} required />
            </div>
            <div>
              <label className="label" htmlFor="portalName">Client portal name</label>
              <input id="portalName" name="portalName" className="input" value={v.portalName} onChange={(e) => set("portalName")(e.target.value)} maxLength={80} placeholder={`${v.name} Client Portal`} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField id="brandColor" label="Brand color" value={v.brandColor} onChange={set("brandColor")} />
            <ColorField id="accentColor" label="Accent color" value={v.accentColor} onChange={set("accentColor")} />
          </div>
          <div>
            <label className="label" htmlFor="portalWelcome">Welcome message</label>
            <textarea id="portalWelcome" name="portalWelcome" className="input min-h-[90px]" value={v.portalWelcome} onChange={(e) => set("portalWelcome")(e.target.value)} maxLength={600} required />
            <p className="mt-1 text-xs text-ink-500">{v.portalWelcome.length}/600 · shown at the top of every client&apos;s portal.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="emailFromName">Email sender name</label>
              <input id="emailFromName" name="emailFromName" className="input" value={v.emailFromName} onChange={(e) => set("emailFromName")(e.target.value)} maxLength={80} placeholder={v.name} />
            </div>
            <div>
              <label className="label" htmlFor="supportEmail">Support email</label>
              <input id="supportEmail" name="supportEmail" type="email" className="input" value={v.supportEmail} onChange={(e) => set("supportEmail")(e.target.value)} placeholder="help@…" />
            </div>
            <div>
              <label className="label" htmlFor="supportPhone">Support phone</label>
              <input id="supportPhone" name="supportPhone" className="input" value={v.supportPhone} onChange={(e) => set("supportPhone")(e.target.value)} placeholder="+1 555 0100" />
            </div>
          </div>
          {canEdit && <SubmitButton pendingText="Saving…">Save branding</SubmitButton>}
        </fieldset>
      </ActionForm>

      <div className="xl:col-span-2">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Live preview · client portal header</p>
        <div className="overflow-hidden rounded-xl border border-ink-200 bg-ink-50 shadow-sm">
          <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${brand}, ${accent})` }} />
          <div className="flex items-center justify-between gap-3 border-b border-ink-200 bg-white px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {initial.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={initial.logoUrl} alt="" className="h-8 w-auto max-w-[120px] object-contain" />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: brand }}>
                  {(v.name.trim()[0] ?? "?").toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink-900">{v.portalName || v.name}</p>
                {v.portalName && <p className="truncate text-xs text-ink-500">{v.name}</p>}
              </div>
            </div>
            <span className="shrink-0 text-xs text-ink-400">Sign out</span>
          </div>
          <div className="space-y-3 p-4">
            <p className="whitespace-pre-line text-sm text-ink-700">{v.portalWelcome}</p>
            <div className="rounded-lg border border-ink-200 bg-white p-3">
              <div className="flex items-center justify-between text-xs text-ink-500">
                <span>Your onboarding progress</span>
                <span className="font-semibold" style={{ color: brand }}>Sample</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100">
                <div className="h-full w-3/5 rounded-full" style={{ background: brand }} />
              </div>
              <button type="button" className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: brand }} tabIndex={-1}>
                Continue
              </button>
              <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${accent}22`, color: brand }}>Accent</span>
            </div>
            {(v.supportEmail || v.supportPhone) && (
              <p className="text-xs text-ink-500">Questions? {[v.supportEmail, v.supportPhone].filter(Boolean).join(" · ")}</p>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-500">Preview only, with a sample progress bar. Emails go out as &ldquo;{v.emailFromName || v.name}&rdquo;.</p>
      </div>
    </div>
  );
}
