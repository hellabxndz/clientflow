import { requireStaff } from "@/lib/session";
import { Badge, Card, Notice } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { AI_DATA_DISCLOSURE, AI_DOCUMENT_DISCLOSURE, aiStatus } from "@/lib/ai";
import { env } from "@/lib/env";
import { updateAiSettingsAction } from "../../actions";

export const metadata = { title: "AI & data" };

export default async function AiSettingsPage() {
  const auth = await requireStaff();
  const admin = auth.role === "admin";
  const status = aiStatus(auth.workspace);
  const configured = !!env.anthropicApiKey;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card title="AI assistance">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-sm text-ink-600">{status.reason}</p>
            <Badge tone={status.available ? "success" : "warning"}>{status.available ? "Active" : configured ? "Off" : "No credentials"}</Badge>
          </div>
          <ActionForm action={updateAiSettingsAction} className="space-y-5">
            <fieldset disabled={!admin} className="space-y-5">
              <label className="flex items-start gap-3">
                <input type="checkbox" name="aiEnabled" defaultChecked={auth.workspace.ai_enabled} className="mt-1 h-4 w-4 rounded" />
                <span>
                  <span className="font-medium">Use AI for summaries, blocker explanations, reminder drafts and missing-info flags</span>
                  <span className="mt-1 block text-sm text-ink-500">When on, this data is sent to Anthropic's API for the onboarding you're viewing, only when someone clicks an assistant button:</span>
                  <ul className="mt-1 list-disc pl-5 text-sm text-ink-500">
                    {AI_DATA_DISCLOSURE.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </span>
              </label>
              <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
                <label className="flex items-start gap-3">
                  <input type="checkbox" name="aiProcessDocuments" defaultChecked={auth.workspace.ai_process_documents} className="mt-1 h-4 w-4 rounded" />
                  <span>
                    <span className="font-medium">Also let AI read uploaded document contents</span>
                    <span className="mt-1 block text-sm text-ink-600">Off by default. {AI_DOCUMENT_DISCLOSURE}</span>
                  </span>
                </label>
                <label className="mt-3 flex items-start gap-3 text-sm">
                  <input type="checkbox" name="acknowledge" className="mt-0.5 h-4 w-4 rounded" defaultChecked={auth.workspace.ai_process_documents} />
                  I understand that document text will be sent to an AI provider and that our client agreements allow it.
                </label>
              </div>
              {admin && <SubmitButton>Save</SubmitButton>}
            </fieldset>
          </ActionForm>
        </Card>
      </div>
      <div className="space-y-6">
        <Notice title="What AI never does">
          AI never approves items, documents or onboardings, and never makes decisions on legal, tax, identity or financial documents. Every suggestion is labeled and needs a person to act on it.
        </Notice>
        <Card title="Without AI">
          <p className="text-sm text-ink-600">Every assistant button still works without credentials: summaries and blocker explanations come from the checklist state, reminder drafts from a template, and missing-info flags from field rules (empty required answers, malformed emails and URLs, unconfirmed access steps).</p>
        </Card>
        {!admin && <Notice>Only admins can change these settings.</Notice>}
      </div>
    </div>
  );
}
