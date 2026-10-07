"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { getAuth } from "@/lib/session";
import { beginEnrollment, confirmEnrollment, disableMfa, regenerateRecoveryCodes, verifyMfa } from "@/lib/mfa";
import { auditAccount } from "@/lib/password-reset";
import { hashPassword, throttle, validatePassword } from "@/lib/auth";
import { sysQuery, withSysTx } from "@/lib/db";
import type { ActionState } from "@/components/forms";

// Account actions use getAuth directly (not actionAuth): someone whose workspace requires two-step
// sign-in must still be able to reach this page to set it up.
async function me() {
  const auth = await getAuth();
  if (!auth) throw new Error("Your session has expired. Please sign in again.");
  return auth;
}

async function passwordMatches(userId: string, password: string) {
  const [row] = await sysQuery<{ password_hash: string | null }>("select password_hash from users where id = $1", [userId]);
  return !!row?.password_hash && (await bcrypt.compare(password, row.password_hash));
}

export async function beginMfaAction(): Promise<void> {
  const auth = await me();
  await beginEnrollment(auth.user.id);
  revalidatePath("/account");
}

export async function confirmMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await me();
  if (!(await throttle(`mfa-setup:${auth.user.id}`, 10))) return { error: "Too many attempts. Please wait a few minutes." };
  const codes = await confirmEnrollment(auth.user.id, String(fd.get("code") ?? ""));
  if (!codes) return { error: "That code didn't match. Check the time on your phone is set automatically and try the newest code." };
  await withSysTx((tx) => auditAccount(tx, auth.user.id, auth.user.id, "auth.mfa_enabled", `${auth.user.email} turned on two-step sign-in`));
  return { ok: "Two-step sign-in is on.", data: { codes } };
}

export async function regenerateCodesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await me();
  if (!(await throttle(`mfa-codes:${auth.user.id}`, 6))) return { error: "Too many attempts. Please wait a few minutes." };
  if ((await verifyMfa(auth.user.id, String(fd.get("code") ?? ""))) !== "totp") return { error: "Enter a current code from your authenticator app." };
  const codes = await regenerateRecoveryCodes(auth.user.id);
  if (!codes) return { error: "Two-step sign-in isn't on." };
  await withSysTx((tx) => auditAccount(tx, auth.user.id, auth.user.id, "auth.mfa_codes_regenerated", "New recovery codes were generated; the old ones stopped working"));
  return { ok: "New recovery codes created. The old ones no longer work.", data: { codes } };
}

export async function disableMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await me();
  if (auth.role !== "client" && auth.workspace.require_staff_mfa)
    return { error: "This workspace requires two-step sign-in for the team. An admin can reset it if you've lost your device." };
  if (!(await throttle(`mfa-off:${auth.user.id}`, 6))) return { error: "Too many attempts. Please wait a few minutes." };
  if (!(await passwordMatches(auth.user.id, String(fd.get("password") ?? "")))) return { error: "That password isn't right." };
  await disableMfa(auth.user.id);
  await withSysTx((tx) => auditAccount(tx, auth.user.id, auth.user.id, "auth.mfa_disabled", `${auth.user.email} turned off two-step sign-in`));
  revalidatePath("/account");
  return { ok: "Two-step sign-in is off." };
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const auth = await me();
  if (!(await throttle(`pw-change:${auth.user.id}`, 6))) return { error: "Too many attempts. Please wait a few minutes." };
  if (!(await passwordMatches(auth.user.id, String(fd.get("current") ?? "")))) return { error: "Your current password isn't right." };
  const next = String(fd.get("password") ?? "");
  if (next !== String(fd.get("confirm") ?? "")) return { error: "The two new passwords don't match." };
  const problem = validatePassword(next);
  if (problem) return { error: problem };
  const hash = await hashPassword(next);
  await withSysTx(async (tx) => {
    await tx.q("update users set password_hash = $2 where id = $1", [auth.user.id, hash]);
    // Keep this device signed in; sign out everywhere else.
    await tx.q("update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null", [auth.user.id, auth.sessionId]);
    await auditAccount(tx, auth.user.id, auth.user.id, "auth.password_changed", "Password changed; other sessions were signed out");
  });
  return { ok: "Password changed. Other devices were signed out." };
}

