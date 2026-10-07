import type { Tx } from "../db";
import { callApi, loadIntegration, recordIntegrationEvent, setIntegrationStatus } from "./store";

type Result = { status: "done" | "skipped" | "failed"; detail: string };

function teamsCard(text: string) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] },
      },
    ],
  };
}

export async function sendChat(provider: "slack" | "teams", webhookUrl: string, text: string) {
  await callApi(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(provider === "slack" ? { text } : teamsCard(text)),
  });
}

/**
 * Posts to Slack or Teams when the workspace has connected it. Demo workspaces never send;
 * missing connections are reported as skipped rather than pretending to succeed.
 */
export async function postChatMessage(
  tx: Tx,
  ws: { id: string; is_demo: boolean },
  provider: "slack" | "teams",
  text: string,
  refs: { clientId?: string | null; onboardingId?: string | null } = {},
): Promise<Result> {
  const name = provider === "slack" ? "Slack" : "Microsoft Teams";
  const base = { workspaceId: ws.id, provider, direction: "outbound" as const, eventType: "chat_message", ...refs };
  if (ws.is_demo) {
    await recordIntegrationEvent(tx, { ...base, status: "skipped", detail: "Demo workspace: nothing is sent" });
    return { status: "skipped", detail: `${name} not sent (demo workspace)` };
  }
  const conn = await loadIntegration(ws.id, provider);
  if (!conn?.secrets.webhookUrl) {
    await recordIntegrationEvent(tx, { ...base, status: "skipped", detail: `${name} is not connected` });
    return { status: "skipped", detail: `${name} is not connected` };
  }
  try {
    await sendChat(provider, conn.secrets.webhookUrl, text);
    await recordIntegrationEvent(tx, { ...base, status: "processed", detail: text.slice(0, 200) });
    await setIntegrationStatus(ws.id, provider, "connected", { event: true });
    return { status: "done", detail: `Posted to ${name}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordIntegrationEvent(tx, { ...base, status: "failed", detail: msg });
    await setIntegrationStatus(ws.id, provider, "error", { error: msg });
    return { status: "failed", detail: `${name}: ${msg}` };
  }
}
