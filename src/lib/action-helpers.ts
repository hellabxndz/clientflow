import { processPendingEvents } from "./automation/engine";
import type { AuthContext } from "./auth";
import type { ActionState } from "@/components/forms";

/** Shared helpers for server actions. */

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const optional = (fd: FormData, k: string) => str(fd, k) || null;
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
export const int = (fd: FormData, k: string, fallback: number | null = null) => {
  const v = str(fd, k);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** Converts an error into a form result. Redirects pass through; RLS errors become a plain permission message. */
export function fail(e: unknown): ActionState {
  if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
  const message = e instanceof Error ? e.message : "Something went wrong.";
  if (/row-level security|permission denied/i.test(message)) return { error: "You don't have permission to do that." };
  return { error: message };
}

export function workspaceOf(auth: AuthContext) {
  return { id: auth.workspace.id, name: auth.workspace.name, is_demo: auth.workspace.is_demo, email_from_name: auth.workspace.email_from_name };
}

/**
 * Runs automation rules for events the last write emitted (the database records them in the same
 * transaction). Called after the write commits. A failure here never undoes the user's change; the
 * cron tick retries unprocessed events.
 */
export async function afterWrite(workspaceId: string) {
  try {
    await processPendingEvents({ workspaceId, maxRounds: 4 });
  } catch (e) {
    console.error("automation processing failed; the scheduled job will retry", e);
  }
}
