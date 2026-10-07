export type IntegrationCategory =
  | "crm"
  | "communication"
  | "storage"
  | "project_management"
  | "accounting"
  | "e_signature"
  | "advertising_access";

export const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  crm: "CRM",
  communication: "Communication",
  storage: "Storage",
  project_management: "Project Management",
  accounting: "Accounting",
  e_signature: "Electronic Signature",
  advertising_access: "Advertising Access",
};

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  /** "adapter": built and connectable. "env": configured by the server operator. "coming_soon": not built. */
  availability: "adapter" | "env" | "coming_soon";
  fields?: ProviderField[];
  /** Whether a "Test connection" call exists for this provider. */
  testable?: boolean;
  /** Inbound webhook path for CRM providers. */
  webhook?: boolean;
  setup?: string[];
  note?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "hubspot",
    name: "HubSpot",
    category: "crm",
    description: "Start onboarding automatically when a deal moves to Closed Won.",
    availability: "adapter",
    webhook: true,
    testable: true,
    fields: [
      { key: "clientSecret", label: "App client secret", secret: true, required: true, help: "Used to verify HubSpot's X-HubSpot-Signature-v3 on every webhook." },
      { key: "accessToken", label: "Private app access token", secret: true, required: true, help: "Read-only scopes: crm.objects.deals.read, crm.objects.companies.read, crm.objects.contacts.read." },
      { key: "wonStage", label: "Closed-won stage ID", placeholder: "closedwon", help: "The dealstage value that means won in your pipeline." },
      { key: "serviceProperty", label: "Deal property holding the service", placeholder: "service_type", help: "Its value is matched to a client type to pick the workflow." },
    ],
    setup: [
      "Create a HubSpot private app with the read scopes listed below and copy its access token.",
      "Create a public or private app webhook subscription for deal.propertyChange on dealstage, pointing at the webhook URL shown here.",
      "Paste the app's client secret so ClientFlow can verify each request's signature.",
    ],
    note: "Adapter built against HubSpot's documented v3 webhook signature and CRM v3 API. Not yet verified against a live HubSpot portal.",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    category: "crm",
    description: "Send closed-won opportunities from a Salesforce Flow HTTP callout.",
    availability: "adapter",
    webhook: true,
    fields: [{ key: "signingSecret", label: "Shared signing secret", secret: true, required: true, help: "Salesforce signs the JSON body with HMAC-SHA256 in the X-ClientFlow-Signature header." }],
    setup: [
      "Generate a long random signing secret and save it here.",
      "In Salesforce, build a record-triggered Flow on Opportunity (StageName = Closed Won) with an HTTP callout to the webhook URL.",
      "Send the JSON fields documented in the README and sign the body with the shared secret.",
    ],
    note: "Normalizer and signature check are covered by tests. The Salesforce Flow itself must be built in your org; not verified against a live org.",
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    category: "crm",
    description: "Create onboarding when a Pipedrive deal is marked won.",
    availability: "adapter",
    webhook: true,
    fields: [
      { key: "webhookPassword", label: "Webhook basic-auth password", secret: true, required: true, help: "Set the same user (clientflow) and password on the Pipedrive webhook." },
      { key: "apiToken", label: "API token (optional)", secret: true, help: "Used to look up organization and person names." },
    ],
    setup: [
      "In Pipedrive, add a webhook for event 'updated.deal' pointing at the webhook URL.",
      "Set HTTP auth user to 'clientflow' and the password saved here.",
    ],
    note: "Payload normalizer and auth check are covered by tests. Not verified against a live Pipedrive account.",
  },
  {
    id: "webhook",
    name: "Any CRM (signed webhook)",
    category: "crm",
    description: "Zapier, Make or your own system can post closed-won deals in ClientFlow's format.",
    availability: "adapter",
    webhook: true,
    fields: [{ key: "signingSecret", label: "Signing secret", secret: true, required: true, help: "Sign the raw JSON body with HMAC-SHA256 (hex) in X-ClientFlow-Signature." }],
  },
  {
    id: "slack",
    name: "Slack",
    category: "communication",
    description: "Post onboarding milestones and escalations to a channel.",
    availability: "adapter",
    testable: true,
    fields: [{ key: "webhookUrl", label: "Incoming webhook URL", secret: true, required: true, placeholder: "https://hooks.slack.com/services/…" }],
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    category: "communication",
    description: "Post milestones to a Teams channel through a Workflows webhook.",
    availability: "adapter",
    testable: true,
    fields: [{ key: "webhookUrl", label: "Workflows webhook URL", secret: true, required: true, help: "Teams Workflows: 'Post to a channel when a webhook request is received'." }],
  },
  { id: "resend", name: "Email delivery (Resend)", category: "communication", description: "Sends invitations, reminders and notifications.", availability: "env" },
  { id: "gmail", name: "Gmail", category: "communication", description: "Send reminders from a team member's Gmail account.", availability: "coming_soon" },
  { id: "outlook", name: "Microsoft Outlook", category: "communication", description: "Send reminders from Outlook / Microsoft 365.", availability: "coming_soon" },
  { id: "clamav", name: "File scanning (ClamAV)", category: "storage", description: "Scans every upload for malware before it is stored.", availability: "env" },
  { id: "google_drive", name: "Google Drive", category: "storage", description: "Copy approved files into the client's Drive folder.", availability: "coming_soon" },
  { id: "dropbox", name: "Dropbox", category: "storage", description: "Copy approved files into a Dropbox folder.", availability: "coming_soon" },
  {
    id: "clickup",
    name: "ClickUp",
    category: "project_management",
    description: "Create a kickoff task in a list when onboarding is ready.",
    availability: "adapter",
    testable: true,
    fields: [
      { key: "apiToken", label: "Personal API token", secret: true, required: true },
      { key: "listId", label: "List ID", required: true, help: "New handoff tasks are created in this list." },
    ],
    note: "Uses ClickUp API v2 (create task). Not yet verified against a live workspace.",
  },
  {
    id: "asana",
    name: "Asana",
    category: "project_management",
    description: "Create a handoff task in an Asana project.",
    availability: "adapter",
    testable: true,
    fields: [
      { key: "accessToken", label: "Personal access token", secret: true, required: true },
      { key: "projectGid", label: "Project GID", required: true },
    ],
    note: "Uses Asana API 1.0 (create task). Not yet verified against a live workspace.",
  },
  {
    id: "monday",
    name: "Monday.com",
    category: "project_management",
    description: "Create an item on a board when onboarding is ready.",
    availability: "adapter",
    testable: true,
    fields: [
      { key: "apiToken", label: "API token", secret: true, required: true },
      { key: "boardId", label: "Board ID", required: true },
    ],
    note: "Uses the monday.com GraphQL API (create_item). Not yet verified against a live account.",
  },
  { id: "quickbooks", name: "QuickBooks", category: "accounting", description: "Look up billing contacts and customer records.", availability: "coming_soon" },
  {
    id: "docusign",
    name: "DocuSign",
    category: "e_signature",
    description: "Track envelope status automatically.",
    availability: "coming_soon",
    note: "Today, signatures are tracked steps: the client signs in your e-signature tool and staff confirm the signed copy.",
  },
  {
    id: "meta_business",
    name: "Meta Business Manager",
    category: "advertising_access",
    description: "Verify partner access to ad accounts, pages and pixels.",
    availability: "coming_soon",
    note: "Access is collected today with delegated-access instructions in templates. Clients are never asked for passwords.",
  },
  {
    id: "google_ads",
    name: "Google Ads",
    category: "advertising_access",
    description: "Verify manager-account (MCC) link requests.",
    availability: "coming_soon",
    note: "Access is collected today with delegated-access instructions in templates. Clients are never asked for passwords.",
  },
];

export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);

export type ConnectionState = "connected" | "not_connected" | "configuration_required" | "coming_soon";

export const STATE_LABEL: Record<ConnectionState, string> = {
  connected: "Connected",
  not_connected: "Not Connected",
  configuration_required: "Configuration Required",
  coming_soon: "Coming Soon",
};
