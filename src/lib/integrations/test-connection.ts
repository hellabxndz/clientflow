import { callApi, loadIntegration, setIntegrationStatus } from "./store";
import { sendChat } from "./chat";

/** Makes a real, read-only (or clearly labeled test) call to the provider and records the outcome. */
export async function testConnection(workspace: { id: string; name: string; is_demo: boolean }, providerId: string) {
  if (workspace.is_demo) throw new Error("Integrations are disabled in demo workspaces so nothing leaves the demo.");
  const conn = await loadIntegration(workspace.id, providerId);
  if (!conn) throw new Error("Save the credentials first.");
  const { config, secrets } = conn;
  try {
    switch (providerId) {
      case "hubspot":
        await callApi("https://api.hubapi.com/crm/v3/objects/deals?limit=1", { headers: { Authorization: `Bearer ${secrets.accessToken}` } });
        break;
      case "slack":
      case "teams":
        await sendChat(providerId, secrets.webhookUrl, `ClientFlow test message from ${workspace.name}. Onboarding updates will appear here.`);
        break;
      case "clickup":
        await callApi(`https://api.clickup.com/api/v2/list/${encodeURIComponent(config.listId)}`, { headers: { Authorization: secrets.apiToken } });
        break;
      case "asana":
        await callApi(`https://app.asana.com/api/1.0/projects/${encodeURIComponent(config.projectGid)}`, { headers: { Authorization: `Bearer ${secrets.accessToken}` } });
        break;
      case "monday": {
        const { json } = await callApi("https://api.monday.com/v2", {
          method: "POST",
          headers: { Authorization: secrets.apiToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query ($ids: [ID!]) { boards (ids: $ids) { id name } }", variables: { ids: [config.boardId] } }),
        });
        const boards = (json as { data?: { boards?: unknown[] } })?.data?.boards ?? [];
        if (boards.length === 0) throw new Error("Board not found for this token.");
        break;
      }
      default:
        throw new Error("This integration is verified by its first signed webhook, not a test call.");
    }
    await setIntegrationStatus(workspace.id, providerId, "connected", { tested: true });
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setIntegrationStatus(workspace.id, providerId, "error", { error: msg, tested: true });
    return { ok: false as const, error: msg };
  }
}
