"use server";

import crypto from "node:crypto";
import dns from "node:dns/promises";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, optional, str } from "@/lib/action-helpers";
import { getStorage } from "@/lib/storage";
import { env } from "@/lib/env";
import type { ActionState } from "@/components/forms";

const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_ROUTE = "/api/branding/logo";

/** Raster logos only. SVG can carry scripts, so it is rejected rather than sanitized. */
const LOGO_TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  png: { mime: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};

export async function updateBrandingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const name = str(fd, "name");
    if (!name || name.length > 120) return { error: "Enter a company name (up to 120 characters)." };
    const brand = str(fd, "brandColor");
    const accent = str(fd, "accentColor");
    if (!HEX.test(brand)) return { error: "Brand color must be a hex value like #7647e8." };
    if (!HEX.test(accent)) return { error: "Accent color must be a hex value like #a78bfa." };
    const welcome = str(fd, "portalWelcome");
    if (!welcome) return { error: "Add a welcome message for the client portal." };
    if (welcome.length > 600) return { error: "Keep the welcome message under 600 characters." };
    const supportEmail = optional(fd, "supportEmail");
    if (supportEmail && !EMAIL.test(supportEmail)) return { error: "Support email isn't a valid email address." };
    const supportPhone = optional(fd, "supportPhone");
    if (supportPhone && !/^[+()\d\s.-]{5,30}$/.test(supportPhone)) return { error: "Support phone can only contain digits, spaces and + ( ) - ." };
    const senderName = optional(fd, "emailFromName");
    if (senderName && (senderName.length > 80 || /[<>"\r\n]/.test(senderName))) return { error: "Email sender name can't contain < > \" or line breaks." };
    const portalName = optional(fd, "portalName");
    if (portalName && portalName.length > 80) return { error: "Keep the portal name under 80 characters." };
    await withTenant(ctx, async (tx) => {
      await tx.q(
        `update workspaces set name = $2, brand_color = $3, accent_color = $4, portal_welcome = $5, email_from_name = $6, portal_name = $7,
           support_email = $8, support_phone = $9 where id = $1`,
        [auth.workspace.id, name, brand.toLowerCase(), accent.toLowerCase(), welcome, senderName, portalName, supportEmail, supportPhone],
      );
      await audit(tx, ctx, "workspace.branding", null, null, "Updated branding and client portal details", { brandColor: brand, accentColor: accent, portalName });
    });
    revalidatePath("/", "layout");
    return { ok: "Branding saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function uploadLogoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const file = fd.get("logo");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose an image to upload." };
    const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
    if (ext === "svg" || file.type === "image/svg+xml")
      return { error: "SVG logos aren't accepted because they can contain scripts. Export a PNG, JPG or WebP instead." };
    const type = LOGO_TYPES[ext];
    if (!type) return { error: "Upload a PNG, JPG or WebP image." };
    if (file.size > MAX_LOGO_BYTES) return { error: "The logo must be 1 MB or smaller." };
    const data = Buffer.from(await file.arrayBuffer());
    if (!type.magic(data)) return { error: `The file content doesn't look like a valid .${ext} image.` };
    const key = `${auth.workspace.id}/branding/${crypto.randomUUID()}`;
    await getStorage().put(key, data);
    const previous = await withTenant(ctx, async (tx) => {
      const prev = await tx.one<{ logo_storage_key: string | null }>("select logo_storage_key from workspaces where id = $1", [auth.workspace.id]);
      await tx.q("update workspaces set logo_storage_key = $2, logo_mime = $3, logo_url = $4 where id = $1", [
        auth.workspace.id,
        key,
        type.mime,
        `${LOGO_ROUTE}?v=${key.slice(-12)}`,
      ]);
      await audit(tx, ctx, "workspace.logo_uploaded", null, null, `Uploaded a new logo (${type.mime}, ${Math.ceil(data.length / 1024)} KB)`);
      return prev?.logo_storage_key ?? null;
    });
    if (previous && previous !== key) await getStorage().delete(previous).catch(() => {});
    revalidatePath("/", "layout");
    return { ok: "Logo uploaded." };
  } catch (e) {
    return fail(e);
  }
}

export async function removeLogoAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const previous = await withTenant(ctx, async (tx) => {
      const prev = await tx.one<{ logo_storage_key: string | null }>("select logo_storage_key from workspaces where id = $1", [auth.workspace.id]);
      await tx.q("update workspaces set logo_storage_key = null, logo_mime = null, logo_url = null where id = $1", [auth.workspace.id]);
      await audit(tx, ctx, "workspace.logo_removed", null, null, "Removed the workspace logo");
      return prev?.logo_storage_key ?? null;
    });
    if (previous) await getStorage().delete(previous).catch(() => {});
    revalidatePath("/", "layout");
    return { ok: "Logo removed." };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCustomDomainAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const domain = str(fd, "customDomain").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
    if (domain && !DOMAIN.test(domain)) return { error: "Enter a domain like portal.youragency.com (no https:// or path)." };
    await withTenant(ctx, async (tx) => {
      await tx.q(
        "update workspaces set custom_domain = $2, custom_domain_status = $3, custom_domain_checked_at = null where id = $1",
        [auth.workspace.id, domain || null, domain ? "pending_dns" : "not_configured"],
      );
      await audit(tx, ctx, "workspace.custom_domain", null, null, domain ? `Set custom domain ${domain} (pending DNS)` : "Removed the custom domain");
    });
    revalidatePath("/app/settings/branding");
    return { ok: domain ? "Saved. Add the DNS record, then run Check DNS." : "Custom domain removed." };
  } catch (e) {
    return fail(e);
  }
}

const norm = (h: string) => h.toLowerCase().replace(/\.$/, "");

async function lookup(domain: string) {
  const expected = norm(new URL(env.appUrl).hostname);
  const cnames = await dns.resolveCname(domain).catch(() => [] as string[]);
  if (cnames.some((c) => norm(c) === expected)) return { ok: true, detail: `CNAME points to ${expected}.` };
  let addresses: string[] = [];
  try {
    addresses = await dns.resolve4(domain);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (cnames.length) return { ok: false, detail: `CNAME points to ${cnames.join(", ")}, not ${expected}.` };
    return { ok: false, detail: code === "ENOTFOUND" || code === "ENODATA" ? `No DNS records found for ${domain}.` : `DNS lookup failed (${code ?? "error"}).` };
  }
  const targets = await dns.resolve4(expected).catch(() => [] as string[]);
  if (targets.length && addresses.some((a) => targets.includes(a))) return { ok: true, detail: `A record matches ${expected} (${addresses.join(", ")}).` };
  return {
    ok: false,
    detail: cnames.length
      ? `CNAME points to ${cnames.join(", ")}, not ${expected}.`
      : `${domain} resolves to ${addresses.join(", ")}${targets.length ? `, but ${expected} is ${targets.join(", ")}` : `, and ${expected} has no public address to compare with`}.`,
  };
}

/** Real DNS lookup for the saved custom domain. Records the result; TLS and routing are not provisioned here. */
export async function checkDnsAction(_: ActionState): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    const ctx = tenantCtx(auth);
    const row = await withTenant(ctx, (tx) => tx.one<{ custom_domain: string | null }>("select custom_domain from workspaces where id = $1", [auth.workspace.id]));
    if (!row?.custom_domain) return { error: "Save a custom domain first." };
    const result = await lookup(row.custom_domain);
    await withTenant(ctx, async (tx) => {
      await tx.q("update workspaces set custom_domain_status = $2, custom_domain_checked_at = now() where id = $1", [
        auth.workspace.id,
        result.ok ? "dns_verified" : "dns_failed",
      ]);
      await audit(tx, ctx, "workspace.custom_domain_checked", null, null, `DNS check for ${row.custom_domain}: ${result.ok ? "verified" : "failed"}`, { detail: result.detail });
    });
    revalidatePath("/app/settings/branding");
    return result.ok ? { ok: `DNS verified. ${result.detail}` } : { error: `DNS not verified. ${result.detail}` };
  } catch (e) {
    return fail(e);
  }
}
