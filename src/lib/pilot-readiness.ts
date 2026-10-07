import type { Tx } from "./db";
import { env } from "./env";
import { emailConnection } from "./email";
import { getScanner } from "./scanning";
import { getStorage } from "./storage";
import { PROVIDERS } from "./integrations/catalog";
import { usingFallbackKey } from "./integrations/crypto";

/**
 * An honest, runtime view of what a pilot can rely on. "Working" means built and active in
 * this deployment; "Requires configuration" means built but switched off or unconfigured here;
 * "Not yet implemented" lists genuine gaps in this build.
 */

export interface ReadinessEntry {
  title: string;
  detail: string;
  href?: string;
}

export interface PilotReadiness {
  working: ReadinessEntry[];
  configure: ReadinessEntry[];
  missing: ReadinessEntry[];
}

export async function pilotReadiness(tx: Tx, workspace: { is_demo: boolean; ai_enabled: boolean }): Promise<PilotReadiness> {
  const working: ReadinessEntry[] = [];
  const configure: ReadinessEntry[] = [];
  const missing: ReadinessEntry[] = [];
  const connected = new Set(
    (await tx.q<{ provider: string }>("select provider from integrations where status = 'connected'")).map((r) => r.provider),
  );
  const [counts] = await tx.q<{ templates: number; reminders: number; automations: number }>(
    `select (select count(*)::int from templates where not archived and current_version > 0) as templates,
            (select count(*)::int from reminder_rules where enabled) as reminders,
            (select count(*)::int from automation_rules where enabled) as automations`,
  );

  // Core product: always on in this build.
  working.push(
    { title: "Client portal and onboarding checklists", detail: "Forms, file requests, access requests, questions, checklists, internal tasks, reviews and readiness scoring." },
    { title: "Tenant isolation", detail: "Every query runs as a restricted database role under Postgres row-level security, scoped to the workspace and, for clients, to their own company." },
    { title: "Role-based permissions", detail: "Admin, Manager, Staff and Client roles are checked in every server action and again by the database." },
    { title: "Private file storage", detail: `Files are stored privately (${getStorage().name}) and downloaded through short-lived links bound to the signed-in user.`, href: "/app/settings/security" },
    { title: "Audit log", detail: "Invitations, reviews, uploads, settings, member, automation and integration changes are recorded.", href: "/app/settings/audit" },
    { title: "Reports", detail: "Calculated from stored records only; sparse data shows \"Not enough data yet.\"", href: "/app/reports" },
    { title: "CSV data import", detail: "Clients, contacts, onboardings, tasks and requirements with column mapping, validation and duplicate checks.", href: "/app/settings/import" },
  );
  if (counts.templates > 0) working.push({ title: "Published templates", detail: `${counts.templates} published.`, href: "/app/templates" });
  else configure.push({ title: "Templates", detail: "No published template yet. Publish one before inviting clients.", href: "/app/templates" });
  if (counts.reminders > 0) working.push({ title: "Reminder rules", detail: `${counts.reminders} enabled.`, href: "/app/settings/reminders" });
  else configure.push({ title: "Reminder rules", detail: "No reminder rule is enabled. Preview one, then enable it.", href: "/app/settings/reminders" });
  if (counts.automations > 0) working.push({ title: "Automations", detail: `${counts.automations} enabled rule${counts.automations === 1 ? "" : "s"}.`, href: "/app/automations" });
  else configure.push({ title: "Automations", detail: "No automation rule is enabled.", href: "/app/automations" });

  // Email
  const email = emailConnection(workspace);
  if (email.mode === "live") working.push({ title: "Email delivery (Resend)", detail: email.detail, href: "/app/settings/email" });
  else
    configure.push({
      title: "Email delivery",
      detail: workspace.is_demo ? "Demo workspace: emails are recorded in the outbox and never sent." : email.detail,
      href: "/app/settings/email",
    });

  // AI
  if (env.anthropicApiKey && workspace.ai_enabled) working.push({ title: "AI assistance", detail: `Advisory summaries and drafts using ${env.aiModel}. Never approves anything.`, href: "/app/settings/ai" });
  else
    configure.push({
      title: "AI assistance",
      detail: env.anthropicApiKey ? "Credentials present but AI is turned off for this workspace." : "ANTHROPIC_API_KEY is not set. Rule-based summaries are used instead.",
      href: "/app/settings/ai",
    });

  // Scanning
  const scanner = getScanner();
  if (scanner.configured) working.push({ title: "Malware scanning (ClamAV)", detail: `Uploads are scanned by clamd at ${env.clamavHost}:${env.clamavPort}.` });
  else configure.push({ title: "Malware scanning", detail: "File scanning integration not configured. Enable before handling sensitive production documents. Set CLAMAV_HOST.", href: "/app/settings/security" });

  // Scheduler
  if (env.cronSecret) working.push({ title: "Scheduled jobs", detail: "CRON_SECRET is set; /api/cron/tick and /api/cron/reminders accept authorized calls. Make sure a scheduler actually calls them." });
  else configure.push({ title: "Scheduled jobs", detail: "CRON_SECRET is not set, so the cron endpoints refuse every call. Time-based reminders and escalations only run when triggered manually." });

  // Secrets and deployment config
  if (usingFallbackKey()) configure.push({ title: "Integration credential encryption key", detail: "INTEGRATION_ENCRYPTION_KEY is not set; credentials are encrypted with a key derived from SESSION_SECRET. Set a dedicated key before connecting real accounts." });
  else working.push({ title: "Encrypted integration credentials", detail: "AES-256-GCM with a dedicated INTEGRATION_ENCRYPTION_KEY." });
  if (env.sessionSecret === "dev-only-insecure-secret-change-me") configure.push({ title: "Session secret", detail: "SESSION_SECRET is using the development default. Set a random value of 32+ characters." });
  if (/localhost|127\.0\.0\.1/.test(env.appUrl)) configure.push({ title: "Public URL", detail: `APP_URL is ${env.appUrl}. Invitation and portal links in emails will point there.` });

  // Integrations
  const crm = PROVIDERS.filter((p) => p.category === "crm" && connected.has(p.id));
  if (crm.length) working.push({ title: "CRM integration", detail: `Connected: ${crm.map((p) => p.name).join(", ")}.`, href: "/app/integrations" });
  else configure.push({ title: "CRM integration", detail: "No CRM connected. Clients can still be added manually or by CSV.", href: "/app/integrations" });
  const chat = PROVIDERS.filter((p) => p.category === "communication" && p.availability === "adapter" && connected.has(p.id));
  if (chat.length) working.push({ title: "Team chat notifications", detail: `Connected: ${chat.map((p) => p.name).join(", ")}.`, href: "/app/integrations" });
  else configure.push({ title: "Slack or Teams notifications", detail: "Not connected. In-app notifications still work.", href: "/app/integrations" });
  const pm = PROVIDERS.filter((p) => p.category === "project_management" && connected.has(p.id));
  if (pm.length) working.push({ title: "Project management handoff", detail: `Connected: ${pm.map((p) => p.name).join(", ")}.`, href: "/app/integrations" });
  else configure.push({ title: "Project management handoff", detail: "ClickUp, Asana and Monday.com adapters exist but none is connected.", href: "/app/integrations" });

  // Genuine gaps in this build.
  missing.push(
    { title: "Single sign-on (SSO / SAML) and multi-factor authentication", detail: "Sign-in is email and password only. There is no SSO, SAML or MFA in this build." },
    { title: "Self-service password reset", detail: "There is no forgot-password flow. An admin can remove and re-invite a user." },
    { title: "Custom domain TLS and routing", detail: "The custom domain field records the domain and checks DNS, but certificates and routing are not provisioned automatically." },
    {
      title: "Object storage other than private local disk",
      detail: `Only the ${getStorage().name} adapter exists. S3-compatible storage needs an adapter before running several app instances.`,
    },
    { title: "Native e-signature", detail: "Signature items are tracked steps: the client signs in your e-signature tool and staff confirm the signed copy." },
    { title: "Compliance certifications", detail: "ClientFlow has not been audited for SOC 2, HIPAA, GDPR or ISO 27001. No certification is claimed." },
  );
  const comingSoon = PROVIDERS.filter((p) => p.availability === "coming_soon");
  if (comingSoon.length)
    missing.push({ title: "Integration adapters marked Coming Soon", detail: `${comingSoon.map((p) => p.name).join(", ")}. These show as Coming Soon and are never simulated as connected.`, href: "/app/integrations" });
  return { working, configure, missing };
}
