"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { acceptInvitation, createSession, revokeSession, switchWorkspace, throttle, verifyCredentials } from "@/lib/auth";
import { actionAuth, clearSessionCookie, getAuth, setSessionCookie, userAgent } from "@/lib/session";
import type { ActionState } from "@/components/forms";

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!throttle(`login:${email}:${ip}`)) return { error: "Too many attempts. Please wait a few minutes and try again." };
  if (!email || !password) return { error: "Enter your email and password." };
  const userId = await verifyCredentials(email, password);
  if (!userId) return { error: "That email and password don't match an account." };
  const { token } = await createSession(userId, null, await userAgent());
  await setSessionCookie(token);
  const auth = await (await import("@/lib/auth")).resolveSession(token);
  if (!auth) return { error: "Your account isn't part of any workspace yet. Ask for a new invitation." };
  redirect(auth.role === "client" ? "/portal" : "/app");
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
  if (!throttle(`invite:${ip}`, 20)) return { error: "Too many attempts. Please wait a few minutes." };
  const result = await acceptInvitation(token, {
    name: String(fd.get("name") ?? ""),
    password: String(fd.get("password") ?? ""),
  });
  if (!result.ok) return { error: result.error };
  const { token: session } = await createSession(result.userId, result.workspaceId, await userAgent());
  await setSessionCookie(session);
  redirect("/");
}

export async function switchWorkspaceAction(fd: FormData) {
  const auth = await actionAuth();
  await switchWorkspace(auth.sessionId, auth.user.id, String(fd.get("workspaceId")));
  redirect("/");
}
