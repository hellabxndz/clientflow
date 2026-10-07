"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { withTenant } from "@/lib/db";
import { tenantCtx, type AuthContext } from "@/lib/auth";
import { actionAuth } from "@/lib/session";
import { audit } from "@/lib/audit";
import { fail, str, workspaceOf } from "@/lib/action-helpers";
import { providerById } from "@/lib/integrations/catalog";
import { disconnectIntegration, saveIntegration } from "@/lib/integrations/store";
import { testConnection } from "@/lib/integrations/test-connection";
import { importClosedWonDeal, type ClosedWonDeal } from "@/lib/integrations/crm";
import type { ActionState } from "@/components/forms";

const DEMO_BLOCK = "Demo workspace: integrations can't be configured here, so nothing ever leaves the demo.";

function adapterProvider(id: string) {
  const p = providerById(id);
  if (!p || p.availability !== "adapter") throw new Error("This integration can't be configured here.");
  return p;
}

async function log(auth: AuthContext, action: string, summary: string, metadata: Record<string, unknown>) {
  const ctx = tenantCtx(auth);
  await withTenant(ctx, (tx) => audit(tx, ctx, action, "integration", null, summary, metadata));
}

export async function saveIntegrationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    if (auth.workspace.is_demo) throw new Error(DEMO_BLOCK);
    const provider = adapterProvider(str(fd, "provider"));
    const values: Record<string, string> = {};
    for (const f of provider.fields ?? []) values[f.key] = str(fd, f.key);
    await saveIntegration(auth.workspace.id, provider.id, values, auth.user.id);
    // Field names only: secret values never reach the audit log.
    await log(auth, "integration.configured", `Saved ${provider.name} settings`, {
      provider: provider.id,
      fields: (provider.fields ?? []).filter((f) => values[f.key]).map((f) => f.key),
    });
    revalidatePath("/app/integrations");
    return { ok: provider.testable ? "Saved. Run a connection test to finish." : "Saved. It shows as Connected after the first verified webhook." };
  } catch (e) {
    return fail(e);
  }
}

export async function testIntegrationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const provider = adapterProvider(str(fd, "provider"));
    const result = await testConnection(workspaceOf(auth), provider.id);
    revalidatePath("/app/integrations");
    if (!result.ok) return { error: `Connection test failed: ${result.error}` };
    await log(auth, "integration.connected", `Connected ${provider.name} (test call succeeded)`, { provider: provider.id });
    return { ok: `${provider.name} is connected.` };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectIntegrationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    const provider = adapterProvider(str(fd, "provider"));
    await disconnectIntegration(auth.workspace.id, provider.id);
    await log(auth, "integration.disconnected", `Disconnected ${provider.name} and deleted its stored credentials`, { provider: provider.id });
    revalidatePath("/app/integrations");
    return { ok: `${provider.name} disconnected. Stored credentials were deleted.` };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Generates a signing secret for Salesforce / signed-webhook senders. HMAC verification needs the raw
 * secret, so it is stored encrypted with the other integration credentials (not as a hash) and shown once.
 */
export async function generateSigningSecretAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("admin");
    if (auth.workspace.is_demo) throw new Error(DEMO_BLOCK);
    const provider = adapterProvider(str(fd, "provider"));
    if (!(provider.fields ?? []).some((f) => f.key === "signingSecret")) throw new Error("This integration doesn't use a signing secret.");
    const secret = crypto.randomBytes(32).toString("hex");
    await saveIntegration(auth.workspace.id, provider.id, { signingSecret: secret }, auth.user.id);
    await log(auth, "integration.configured", `Generated a new ${provider.name} signing secret`, { provider: provider.id });
    revalidatePath("/app/integrations");
    return { ok: "New signing secret generated. Copy it now; it won't be shown again.", data: { secret } };
  } catch (e) {
    return fail(e);
  }
}

const SIM_PROVIDERS = new Set(["hubspot", "salesforce", "pipedrive"]);

/** Demo workspaces only: runs the real import pipeline with a made-up deal. No CRM is contacted. */
export async function simulateDealAction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const auth = await actionAuth("manager");
    if (!auth.workspace.is_demo) throw new Error("Deal simulation is only available in demo workspaces.");
    const provider = SIM_PROVIDERS.has(str(fd, "provider")) ? str(fd, "provider") : "hubspot";
    const company = str(fd, "company");
    if (company.length < 2) throw new Error("Enter the company name.");
    const email = str(fd, "contactEmail");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid contact email or leave it empty.");
    const amountRaw = str(fd, "amount");
    const amount = amountRaw ? Number(amountRaw) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error("Enter a positive amount.");
    const recurrence = (["one_time", "monthly", "annual"] as const).find((r) => r === str(fd, "recurrence")) ?? "monthly";
    const service = str(fd, "serviceType") || null;
    const deal: ClosedWonDeal = {
      provider,
      externalId: `sim-${crypto.randomUUID()}`,
      dealName: `${company.slice(0, 150)}${service ? ` - ${service}` : ""}`,
      companyName: company.slice(0, 200),
      contactName: str(fd, "contactName") || null,
      contactEmail: email || null,
      amount,
      recurrence,
      serviceType: service,
    };
    const result = await importClosedWonDeal(auth.workspace.id, deal, { simulated: true });
    revalidatePath("/app/integrations");
    revalidatePath("/app/clients");
    return {
      ok: result.status === "existing_client" ? `${company} already existed, so the deal was attached to that client.` : `${company} was created from the simulated deal.`,
      data: { clientId: result.clientId },
    };
  } catch (e) {
    return fail(e);
  }
}
