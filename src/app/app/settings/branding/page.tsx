import { requireStaff } from "@/lib/session";
import { tenantCtx } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { formatDateTime } from "@/lib/time";
import { env } from "@/lib/env";
import { BrandingForm } from "./branding-form";
import { checkDnsAction, removeLogoAction, saveCustomDomainAction, uploadLogoAction } from "./actions";

export const metadata = { title: "Branding" };

const DOMAIN_STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  not_configured: { label: "Not configured", tone: "neutral" },
  pending_dns: { label: "Pending DNS", tone: "warning" },
  dns_verified: { label: "DNS verified", tone: "success" },
  dns_failed: { label: "DNS check failed", tone: "danger" },
};

export default async function BrandingPage() {
  const auth = await requireStaff();
  const canEdit = can(auth.role, "manageBranding");
  const ws = await withTenant(tenantCtx(auth), (tx) =>
    tx.one<{
      name: string;
      brand_color: string;
      accent_color: string;
      portal_welcome: string;
      email_from_name: string | null;
      portal_name: string | null;
      support_email: string | null;
      support_phone: string | null;
      logo_url: string | null;
      logo_storage_key: string | null;
      logo_mime: string | null;
      custom_domain: string | null;
      custom_domain_status: string;
      custom_domain_checked_at: Date | null;
    }>(
      `select name, brand_color, accent_color, portal_welcome, email_from_name, portal_name, support_email, support_phone, logo_url,
              logo_storage_key, logo_mime, custom_domain, custom_domain_status, custom_domain_checked_at
       from workspaces where id = $1`,
      [auth.workspace.id],
    ),
  );
  if (!ws) return null;
  const status = DOMAIN_STATUS[ws.custom_domain_status] ?? DOMAIN_STATUS.not_configured;
  const appHost = new URL(env.appUrl).hostname;
  return (
    <div className="space-y-6">
      {!canEdit && <Notice>Only managers and admins can change branding. You can see the current settings below.</Notice>}
      <Card title="Brand and client portal">
        <BrandingForm
          canEdit={canEdit}
          initial={{
            name: ws.name,
            brandColor: ws.brand_color,
            accentColor: ws.accent_color,
            portalWelcome: ws.portal_welcome,
            emailFromName: ws.email_from_name ?? "",
            portalName: ws.portal_name ?? "",
            supportEmail: ws.support_email ?? "",
            supportPhone: ws.support_phone ?? "",
            logoUrl: ws.logo_url,
          }}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Logo">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex h-20 w-40 shrink-0 items-center justify-center rounded-lg border border-dashed border-ink-200 bg-ink-50 p-2">
              {ws.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ws.logo_url} alt={`${ws.name} logo`} className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-xs text-ink-400">No logo</span>
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              {canEdit && (
                <ActionForm action={uploadLogoAction} className="space-y-2" resetOnSuccess>
                  <input name="logo" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-2 file:text-sm file:font-medium" required />
                  <SubmitButton className="btn-secondary" pendingText="Uploading…">Upload logo</SubmitButton>
                </ActionForm>
              )}
              <p className="text-xs text-ink-500">
                PNG, JPG or WebP, up to 1 MB. The file type is checked by extension and by its content. SVG is not accepted: SVG files can contain scripts, so we only store raster images.
                Logos are stored privately and served only to signed-in members of this workspace, including your clients.
              </p>
              {canEdit && ws.logo_url && (
                <ActionForm action={removeLogoAction} confirm="Remove the logo?" showSuccess={false}>
                  <SubmitButton className="btn-ghost px-2 py-1 text-xs text-rose-700">Remove logo</SubmitButton>
                </ActionForm>
              )}
            </div>
          </div>
        </Card>

        <Card title="Custom domain" action={<Badge tone={status.tone}>{status.label}</Badge>}>
          <Notice tone="warning" className="mb-4">
            Custom domain setup requires DNS configuration. TLS certificates and routing for the domain are not provisioned automatically in this build: your hosting provider must be set up to serve ClientFlow on it.
          </Notice>
          <ActionForm action={saveCustomDomainAction} className="space-y-2">
            <fieldset disabled={!canEdit} className="space-y-2">
              <label className="label" htmlFor="customDomain">Domain</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input id="customDomain" name="customDomain" className="input font-mono" defaultValue={ws.custom_domain ?? ""} placeholder="portal.youragency.com" />
                {canEdit && <SubmitButton className="btn-secondary shrink-0">Save</SubmitButton>}
              </div>
            </fieldset>
          </ActionForm>
          {ws.custom_domain && (
            <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
              <div className="overflow-x-auto rounded-lg bg-ink-50 p-3 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">DNS record to add</p>
                <p className="mt-1 font-mono text-xs">
                  {ws.custom_domain} &nbsp;CNAME&nbsp; {appHost}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {canEdit && (
                  <ActionForm action={checkDnsAction}>
                    <SubmitButton className="btn-secondary" pendingText="Checking DNS…">Check DNS</SubmitButton>
                  </ActionForm>
                )}
                <p className="text-xs text-ink-500">{ws.custom_domain_checked_at ? `Last checked ${formatDateTime(ws.custom_domain_checked_at)}` : "Not checked yet"}</p>
              </div>
              <p className="text-xs text-ink-500">Check DNS runs a live lookup (CNAME, then A records) and records the result. It does not issue certificates or change routing.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
