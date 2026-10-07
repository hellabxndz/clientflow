import type { Tx } from "./db";
import { emailConnection } from "./email";
import { PROVIDERS } from "./integrations/catalog";

/**
 * Implementation checklist for a workspace going live. Every automatic item is computed from
 * stored records; only the steps a person has to judge (testing a demo client, reviewing the
 * portal, reviewing security) are manual flags kept in workspaces.launch_checklist.
 */

export const MANUAL_LAUNCH_KEYS = ["test_onboarding", "portal_reviewed", "security_review"] as const;
export type ManualLaunchKey = (typeof MANUAL_LAUNCH_KEYS)[number];

export type LaunchFlag = { done: boolean; at: string; by: string | null };
export type LaunchFlags = Partial<Record<string, LaunchFlag>>;

export interface LaunchItem {
  key: string;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
  done: boolean;
  /** "auto": computed from data. "manual": someone ticks it off. "launch": the final step. */
  mode: "auto" | "manual" | "launch";
  detail: string;
  doneAt?: string | null;
  doneBy?: string | null;
}

export const DEFAULT_BRAND_COLOR = "#7647e8";
const CRM_PROVIDERS = PROVIDERS.filter((p) => p.category === "crm").map((p) => p.id);

interface WorkspaceRow {
  id: string;
  name: string;
  timezone: string | null;
  is_demo: boolean;
  brand_color: string;
  logo_url: string | null;
  logo_storage_key: string | null;
  portal_name: string | null;
  launch_checklist: LaunchFlags;
  launched_at: Date | null;
}

export async function launchChecklist(tx: Tx, workspaceId: string) {
  const ws = (await tx.one<WorkspaceRow>(
    `select id, name, timezone, is_demo, brand_color, logo_url, logo_storage_key, portal_name, launch_checklist, launched_at
     from workspaces where id = $1`,
    [workspaceId],
  ))!;
  const [counts] = await tx.q<{ staff: number; client_types: number; published: number; reminders: number; crm: number; crm_names: string[] | null }>(
    `select
       (select count(*)::int from memberships where role in ('admin', 'manager', 'staff')) as staff,
       (select count(*)::int from client_types) as client_types,
       (select count(*)::int from templates where not archived and current_version > 0) as published,
       (select count(*)::int from reminder_rules where enabled) as reminders,
       (select count(*)::int from integrations where status = 'connected' and provider = any($1)) as crm,
       (select array_agg(provider) from integrations where status = 'connected' and provider = any($1)) as crm_names`,
    [CRM_PROVIDERS],
  );
  const flags = ws.launch_checklist ?? {};
  const names = new Map(
    (await tx.q<{ id: string; name: string }>("select u.id, u.name from memberships m join users u on u.id = m.user_id where m.role <> 'client'")).map((u) => [u.id, u.name]),
  );
  const manual = (key: ManualLaunchKey) => {
    const f = flags[key];
    return { done: !!f?.done, doneAt: f?.done ? f.at : null, doneBy: f?.done && f.by ? names.get(f.by) ?? "A former team member" : null };
  };
  const email = emailConnection({ is_demo: ws.is_demo });
  const hasLogo = !!(ws.logo_storage_key || ws.logo_url);
  const customColor = ws.brand_color.toLowerCase() !== DEFAULT_BRAND_COLOR;

  const items: LaunchItem[] = [
    {
      key: "company",
      label: "Company information",
      description: "Workspace name and time zone are set.",
      href: "/app/settings",
      linkLabel: "Company settings",
      mode: "auto",
      done: !!ws.name.trim() && !!ws.timezone,
      detail: `${ws.name} · ${ws.timezone ?? "no time zone"}`,
    },
    {
      key: "branding",
      label: "Branding",
      description: "A logo or custom brand color, plus a client portal name.",
      href: "/app/settings/branding",
      linkLabel: "Branding",
      mode: "auto",
      done: (hasLogo || customColor) && !!ws.portal_name?.trim(),
      detail: [hasLogo ? "Logo uploaded" : customColor ? "Custom brand color" : "Default logo and color", ws.portal_name ? `portal "${ws.portal_name}"` : "no portal name"].join(" · "),
    },
    {
      key: "team",
      label: "Team invited",
      description: "At least two team members can sign in.",
      href: "/app/settings/team",
      linkLabel: "Team",
      mode: "auto",
      done: counts.staff >= 2,
      detail: `${counts.staff} team member${counts.staff === 1 ? "" : "s"}`,
    },
    {
      key: "client_types",
      label: "Client types configured",
      description: "Service lines that map CRM deals to the right workflow.",
      href: "/app/settings/client-types",
      linkLabel: "Client types",
      mode: "auto",
      done: counts.client_types >= 1,
      detail: `${counts.client_types} client type${counts.client_types === 1 ? "" : "s"}`,
    },
    {
      key: "templates",
      label: "Templates configured",
      description: "At least one published onboarding template.",
      href: "/app/templates",
      linkLabel: "Templates",
      mode: "auto",
      done: counts.published >= 1,
      detail: `${counts.published} published template${counts.published === 1 ? "" : "s"}`,
    },
    {
      key: "reminders",
      label: "Reminder rules configured",
      description: "At least one previewed and enabled reminder rule.",
      href: "/app/settings/reminders",
      linkLabel: "Reminders",
      mode: "auto",
      done: counts.reminders >= 1,
      detail: `${counts.reminders} enabled rule${counts.reminders === 1 ? "" : "s"}`,
    },
    {
      key: "email",
      label: "Email provider configured",
      description: "Real email delivery is connected (not demo mode).",
      href: "/app/settings/email",
      linkLabel: "Email",
      mode: "auto",
      done: email.mode === "live",
      detail: email.detail,
    },
    {
      key: "crm",
      label: "CRM configured",
      description: "A CRM integration is connected so closed-won deals start onboarding.",
      href: "/app/integrations",
      linkLabel: "Integrations",
      mode: "auto",
      done: counts.crm >= 1,
      detail: counts.crm ? `Connected: ${(counts.crm_names ?? []).join(", ")}` : "No CRM connected yet",
    },
    {
      key: "test_onboarding",
      label: "Demo client tested",
      description: "Someone ran a test client through the portal end to end.",
      href: "/app/clients/new",
      linkLabel: "Create a test client",
      mode: "manual",
      ...manual("test_onboarding"),
      detail: "",
    },
    {
      key: "portal_reviewed",
      label: "Portal reviewed",
      description: "The client portal's wording, branding and requests were reviewed.",
      href: "/app/settings/branding",
      linkLabel: "Portal branding",
      mode: "manual",
      ...manual("portal_reviewed"),
      detail: "",
    },
    {
      key: "security_review",
      label: "Security and pilot readiness reviewed",
      description: "The Security and Pilot Readiness pages were read and gaps accepted or fixed.",
      href: "/app/settings/pilot-readiness",
      linkLabel: "Pilot readiness",
      mode: "manual",
      ...manual("security_review"),
      detail: "",
    },
  ];
  items.push({
    key: "launch",
    label: "Ready to launch",
    description: "Marks the go-live date. Reports compare onboarding before and after this date.",
    href: "/app/reports",
    linkLabel: "Reports",
    mode: "launch",
    done: !!ws.launched_at,
    detail: ws.launched_at ? `Launched ${new Date(ws.launched_at).toISOString().slice(0, 10)}` : "Not launched yet",
    doneAt: ws.launched_at ? new Date(ws.launched_at).toISOString() : null,
  });
  const steps = items.filter((i) => i.mode !== "launch");
  return { items, done: steps.filter((i) => i.done).length, total: steps.length, launchedAt: ws.launched_at };
}
