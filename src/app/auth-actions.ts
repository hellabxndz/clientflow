"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { acceptInvitation, createSession, resolveSession, revokeSession, switchWorkspace, throttle, verifyCredentials } from "@/lib/auth";
import { actionAuth, clearSessionCookie, getAuth, setSessionCookie, userAgent } from "@/lib/session";
import { mfaEnabled, verifyMfa } from "@/lib/mfa";
import { completePasswordReset, requestPasswordReset, auditAccount } from "@/lib/password-reset";
import { withSysTx } from "@/lib/db";
import { signPayload, verifyPayload } from "@/lib/tokens";
import { env } from "@/lib/env";
import type { ActionState } from "@/components/forms";

const MFA_COOKIE = "cf_mfa";
const MFA_CHALLENGE_SECONDS = 5 * 60;

async function clientIp() {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

async function startSession(userId: string, workspaceId: string | null = null) {
  const { token } = await createSession(userId, workspaceId, await userAgent());
  await setSessionCookie(token);
  const auth = await resolveSession(token);
  if (!auth) return { error: "Your account isn't part of any workspace yet. Ask for a new invitation." };
  redirect(auth.role === "client" ? "/portal" : "/app");
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const ip = await clientIp();
  if (!(await throttle(`login:${email}:${ip}`))) return { error: "Too many attempts. Please wait a few minutes and try again." };
  if (!email || !password) return { error: "Enter your email and password." };
  const userId = await verifyCredentials(email, password);
  if (!userId) return { error: "That email and password don't match an account." };
  if (await mfaEnabled(userId)) {
    // Password is right; no session until the second step succeeds.
    (await cookies()).set(MFA_COOKIE, signPayload({ uid: userId, purpose: "mfa" }, MFA_CHALLENGE_SECONDS), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      path: "/login",
      maxAge: MFA_CHALLENGE_SECONDS,
    });
    redirect("/login/verify");
  }
  return startSession(userId);
}

/** Second sign-in step: a code from the authenticator app, or a one-time recovery code. */
export async function verifyMfaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const store = await cookies();
  const challenge = verifyPayload<{ uid: string; purpose: string }>(store.get(MFA_COOKIE)?.value ?? "");
  if (!challenge || challenge.purpose !== "mfa") return { error: "That sign-in attempt expired. Sign in again." };
  if (!(await throttle(`mfa:${challenge.uid}`, 6))) return { error: "Too many attempts. Please wait a few minutes and sign in again." };
  const how = await verifyMfa(challenge.uid, String(fd.get("code") ?? ""));
  if (!how) return { error: "That code didn't work. Codes change every 30 seconds; use the newest one." };
  store.delete({ name: MFA_COOKIE, path: "/login" });
  if (how === "recovery")
    await withSysTx((tx) => auditAccount(tx, challenge.uid, challenge.uid, "auth.mfa_recovery_code_used", "Signed in with a recovery code"));
  return startSession(challenge.uid);
}

export async function requestResetAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter the email you sign in with." };
  const ip = await clientIp();
  // Same answer whether or not the account exists, and whether or not we were throttled.
  const answer = { ok: "If that email has an account, we've sent a link to reset the password. It works for 60 minutes." };
  if (!(await throttle(`reset:${ip}`, 10)) || !(await throttle(`reset:${email}`, 3, 60 * 60 * 1000))) return answer;
  await requestPasswordReset(email, ip);
  return answer;
}

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  if (!(await throttle(`reset-use:${await clientIp()}`, 20))) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await completePasswordReset(token, password);
  if (!result.ok) return { error: result.error };
  redirect("/login?reset=1");
}

export async function logoutAction() {
  const auth = await getAuth();
  if (auth) await revokeSession(auth.sessionId, auth.user.id);
  await clearSessionCookie();
  redirect("/login");
}

export async function acceptInviteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const token = String(fd.get("token") ?? "");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!(await throttle(`invite:${ip}`, 20))) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await acceptInvitation(token, {
    name: String(fd.get("name") ?? ""),
    password: String(fd.get("password") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  // An existing account with two-step sign-in still has to pass the second step.
  if (await mfaEnabled(result.userId)) redirect("/login?joined=1");
  const { token: session } = await createSession(result.userId, result.workspaceId, await userAgent());
  await setSessionCookie(session);
  redirect("/");
}

export async function switchWorkspaceAction(fd: FormData) {
  const auth = await actionAuth();
  await switchWorkspace(auth.sessionId, auth.user.id, String(fd.get("workspaceId")));
  redirect("/");
}
