import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { resolveSession, SESSION_COOKIE, SESSION_TTL_DAYS, type AuthContext } from "./auth";
import { env } from "./env";

export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
});

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86400,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function userAgent() {
  return (await headers()).get("user-agent");
}

export async function requireAuth() {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  return auth;
}

/** True when this workspace requires two-step sign-in for its team and this staff member hasn't set it up. */
export function mfaSetupRequired(auth: AuthContext) {
  return auth.role !== "client" && auth.workspace.require_staff_mfa && !auth.user.mfa_enabled;
}

export async function requireStaff() {
  const auth = await requireAuth();
  if (auth.role === "client") redirect("/portal");
  if (mfaSetupRequired(auth)) redirect("/account?required=1");
  return auth;
}

export async function requireAdmin() {
  const auth = await requireStaff();
  if (auth.role !== "admin") redirect("/app?denied=1");
  return auth;
}

export async function requireManager() {
  const auth = await requireStaff();
  if (auth.role !== "admin" && auth.role !== "manager") redirect("/app?denied=1");
  return auth;
}

export async function requireClient() {
  const auth = await requireAuth();
  if (auth.role !== "client") redirect("/app");
  return auth;
}

/** For server actions: throws instead of redirecting so failures surface as errors. */
export async function actionAuth(kind: "staff" | "manager" | "admin" | "client" | "any" = "any") {
  const auth = await getAuth();
  if (!auth) throw new Error("Your session has expired. Please sign in again.");
  if (mfaSetupRequired(auth)) throw new Error("This workspace requires two-step sign-in. Set it up from your account page first.");
  if (kind === "staff" && auth.role === "client") throw new Error("Not allowed");
  if (kind === "manager" && auth.role !== "admin" && auth.role !== "manager") throw new Error("Only managers and admins can do that.");
  if (kind === "admin" && auth.role !== "admin") throw new Error("Only workspace admins can do that.");
  if (kind === "client" && auth.role !== "client") throw new Error("Not allowed");
  return auth;
}
