import type { Tx } from "../db";
import { callApi, loadIntegration, recordIntegrationEvent, setIntegrationStatus } from "./store";

export type PmProvider = "clickup" | "asana" | "monday";
const NAMES: Record<PmProvider, string> = { clickup: "ClickUp", asana: "Asana", monday: "Monday.com" };

export interface HandoffInput {
  name: string;
  summary: string;
  link: string;
  clientName: string;
  clientId: string;
  onboardingId: string;
}

/** Creates the delivery handoff item in the PM tool. Returns the external id. */
export async function createPmItem(provider: PmProvider, config: Record<string, string>, secrets: Record<string, string>, input: HandoffInput) {
  const notes = `${input.summary}\n\nOnboarding record: ${input.link}`;
  if (provider === "clickup") {
    const { json } = await callApi(`https://api.clickup.com/api/v2/list/${encodeURIComponent(config.listId)}/task`, {
      method: "POST",
      headers: { Authorization: secrets.apiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, description: notes }),
    });
    return String((json as { id?: string })?.id ?? "");
  }
  if (provider === "asana") {
    const { json } = await callApi("https://app.asana.com/api/1.0/tasks", {
      method: "POST",
      headers: { Authorization: `Bearer ${secrets.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { name: input.name, notes, projects: [config.projectGid] } }),
    });
    return String((json as { data?: { gid?: string } })?.data?.gid ?? "");
  }
  const { json } = await callApi("https://api.monday.com/v2", {
    method: "POST",
    headers: { Authorization: secrets.apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "mutation ($board: ID!, $name: String!) { create_item (board_id: $board, item_name: $name) { id } }",
      variables: { board: config.boardId, name: input.name },
    }),
  });
  const errors = (json as { errors?: { message: string }[] })?.errors;
  if (errors?.length) throw new Error(errors[0].message);
  return String((json as { data?: { create_item?: { id?: string } } })?.data?.create_item?.id ?? "");
}

/** Project-management handoff. Skips honestly when the tool isn't connected or the workspace is a demo. */
export async function runHandoff(
  tx: Tx,
  ws: { id: string; is_demo: boolean },
  provider: PmProvider,
  input: HandoffInput,
): Promise<{ status: "done" | "skipped" | "failed"; detail: string }> {
  const base = {
    workspaceId: ws.id,
    provider,
    direction: "outbound" as const,
    eventType: "handoff",
    clientId: input.clientId,
    onboardingId: input.onboardingId,
  };
  if (ws.is_demo) {
    await recordIntegrationEvent(tx, { ...base, status: "skipped", detail: "Demo workspace: no external project created" });
    return { status: "skipped", detail: `${NAMES[provider]} handoff not sent (demo workspace)` };
  }
  const conn = await loadIntegration(ws.id, provider);
  if (!conn) {
    await recordIntegrationEvent(tx, { ...base, status: "skipped", detail: `${NAMES[provider]} is not connected` });
    return { status: "skipped", detail: `${NAMES[provider]} is not connected` };
  }
  try {
    const id = await createPmItem(provider, conn.config, conn.secrets, input);
    await recordIntegrationEvent(tx, { ...base, status: "processed", detail: `Created "${input.name}"`, externalId: id || null });
    await setIntegrationStatus(ws.id, provider, "connected", { event: true });
    return { status: "done", detail: `Created "${input.name}" in ${NAMES[provider]}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordIntegrationEvent(tx, { ...base, status: "failed", detail: msg });
    await setIntegrationStatus(ws.id, provider, "error", { error: msg });
    return { status: "failed", detail: `${NAMES[provider]}: ${msg}` };
  }
}
