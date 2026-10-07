import type { TemplateContent, TemplateItem } from "./templates";

export interface LibraryTemplate {
  name: string;
  description: string;
  category: string;
  content: TemplateContent;
}

const DELEGATED_NOTE =
  "Never send us passwords. Each step gives our team its own access through the platform's sharing settings, which you can remove at any time.";

const ACCESS_FOOTER =
  "\n\nWe will never ask for your password. If you get stuck, leave a note below and we'll walk you through it on a call.";

// ---------------------------------------------------------------------------
// Building blocks for agency workflows
// ---------------------------------------------------------------------------

type Section = TemplateContent["sections"][number];

const businessDetails = (): Section => ({
  key: "business",
  title: "Business details",
  description: "The basics we need to set up your account.",
  items: [
    {
      key: "business_profile",
      kind: "form",
      title: "Business details",
      audience: "client",
      required: true,
      weight: 3,
      dueOffsetDays: 2,
      fields: [
        { key: "business_name", label: "Business name", type: "text", required: true },
        { key: "website", label: "Website", type: "url", required: true },
        {
          key: "industry",
          label: "Industry",
          type: "select",
          required: true,
          options: ["Healthcare", "Dental", "Fitness", "Beauty and wellness", "Home services", "Legal", "E-commerce", "SaaS", "Professional services", "Hospitality", "Other"],
        },
        { key: "services", label: "Services or products you sell", type: "textarea", required: true },
        { key: "locations", label: "Locations you serve", type: "textarea", required: true, help: "Cities, regions, or 'nationwide'." },
        { key: "description", label: "Describe your business in a few sentences", type: "textarea", required: true },
      ],
    },
  ],
});

const goals = (): Section => ({
  key: "goals",
  title: "Goals",
  description: "What success looks like for you.",
  items: [
    {
      key: "goals_audience",
      kind: "form",
      title: "Goals and audience",
      audience: "client",
      required: true,
      weight: 3,
      dueOffsetDays: 3,
      fields: [
        { key: "primary_goal", label: "Primary goal", type: "textarea", required: true },
        { key: "secondary_goal", label: "Secondary goal", type: "textarea", required: false },
        { key: "revenue_target", label: "Revenue target (next 12 months)", type: "text", required: false },
        { key: "lead_target", label: "Lead target per month", type: "number", required: false },
        { key: "target_audience", label: "Target audience", type: "textarea", required: true },
        { key: "ideal_customer", label: "Describe your ideal customer", type: "textarea", required: true },
        { key: "main_offer", label: "Main offer", type: "textarea", required: true },
        { key: "customer_value", label: "Average customer value ($)", type: "number", required: false },
      ],
    },
  ],
});

const brandAssets = (opts: { full: boolean }): Section => ({
  key: "brand",
  title: "Brand assets",
  description: "Upload the files our creative team works from.",
  items: [
    {
      key: "logo_files",
      kind: "file",
      title: "Final logo files",
      description: "Vector (SVG, EPS, AI) or high-resolution PNG, including any light/dark versions.",
      audience: "client",
      required: true,
      critical: true,
      weight: 2,
      category: "brand",
      dueOffsetDays: 4,
      file: { accept: ["svg", "eps", "ai", "png", "pdf", "zip"], maxSizeMb: 50, maxFiles: 10 },
      review: { required: true },
    },
    {
      key: "brand_guidelines",
      kind: "file",
      title: "Brand guide",
      description: "Brand book or style guide, if you have one.",
      audience: "client",
      required: true,
      weight: 2,
      category: "brand",
      dueOffsetDays: 4,
      file: { accept: ["pdf", "pptx", "key", "zip"], maxSizeMb: 50, maxFiles: 3 },
    },
    {
      key: "creative_questionnaire",
      kind: "form",
      title: "Fonts, colors and creative preferences",
      audience: "client",
      required: opts.full,
      weight: 2,
      dueOffsetDays: 5,
      fields: [
        { key: "fonts", label: "Brand fonts", type: "text", required: false },
        { key: "colors", label: "Brand colors (hex codes if you have them)", type: "text", required: true },
        { key: "tone", label: "How should your brand sound?", type: "textarea", required: true },
        { key: "likes", label: "Ads or brands whose look you like", type: "textarea", required: false },
        { key: "avoid", label: "Anything we should avoid?", type: "textarea", required: false },
      ],
    },
    {
      key: "existing_creative",
      kind: "file",
      title: "Existing creative",
      description: "Past ads, landing pages or social posts that worked well.",
      audience: "client",
      required: false,
      category: "creative",
      dueOffsetDays: 6,
      file: { accept: ["png", "jpg", "jpeg", "pdf", "zip", "mp4", "mov"], maxSizeMb: 100, maxFiles: 20 },
    },
    {
      key: "photos_videos",
      kind: "file",
      title: "Photos and videos",
      description: "Team, location, product or customer photos you're happy for us to use.",
      audience: "client",
      required: false,
      category: "creative",
      dueOffsetDays: 6,
      file: { accept: ["png", "jpg", "jpeg", "zip", "mp4", "mov"], maxSizeMb: 100, maxFiles: 20 },
    },
  ],
});

const contacts = (): Section => ({
  key: "contacts",
  title: "Contacts",
  items: [
    {
      key: "contacts",
      kind: "form",
      title: "Who we should work with",
      audience: "client",
      required: true,
      critical: true,
      weight: 2,
      dueOffsetDays: 2,
      fields: [
        { key: "primary_name", label: "Primary contact name", type: "text", required: true },
        { key: "primary_email", label: "Primary contact email", type: "email", required: true },
        { key: "primary_phone", label: "Primary contact phone", type: "phone", required: false },
        { key: "billing_name", label: "Billing contact name", type: "text", required: true },
        { key: "billing_email", label: "Billing contact email", type: "email", required: true },
        { key: "marketing_name", label: "Marketing contact name", type: "text", required: false },
        { key: "marketing_email", label: "Marketing contact email", type: "email", required: false },
        { key: "approver_name", label: "Who approves creative and spend?", type: "text", required: true },
        { key: "approver_email", label: "Approver email", type: "email", required: true },
      ],
    },
  ],
});

const projectRequirements = (services: string[]): Section => ({
  key: "project",
  title: "Project requirements",
  items: [
    {
      key: "project_scope",
      kind: "form",
      title: "Project requirements",
      audience: "client",
      required: true,
      weight: 3,
      dueOffsetDays: 5,
      dependsOn: ["goals_audience"],
      fields: [
        { key: "services_purchased", label: "Services purchased", type: "multiselect", required: true, options: services },
        { key: "launch_priority", label: "What should launch first?", type: "textarea", required: true },
        { key: "campaign_goals", label: "Campaign goals", type: "textarea", required: true },
        { key: "offer_details", label: "Offer details", type: "textarea", required: true },
        { key: "promotions", label: "Upcoming promotions or seasonal dates", type: "textarea", required: false },
        { key: "geo_targeting", label: "Geographic targeting", type: "textarea", required: true },
        { key: "restrictions", label: "Legal, compliance or brand restrictions", type: "textarea", required: false, help: "For example: claims you can't make, regulated wording, competitor names to avoid." },
      ],
    },
    {
      key: "anything_else",
      kind: "question",
      title: "Anything else we should know?",
      audience: "client",
      required: false,
    },
  ],
});

interface AccessSpec {
  key: string;
  platform: string;
  title: string;
  steps: string;
  level: string;
  accountIdLabel?: string;
  helpUrl?: string;
  critical?: boolean;
  required?: boolean;
}

const ACCESS: Record<string, AccessSpec> = {
  meta: {
    key: "access_meta_bm",
    platform: "Meta Business Manager",
    title: "Meta Business Manager partner access",
    steps:
      "1. Open business.facebook.com and go to Settings → Users → Partners.\n2. Click Add → Give a partner access to your assets.\n3. Enter the Business Manager ID from your welcome email.\n4. Share your ad account, Facebook Page and pixel/dataset with Partial or Full access.",
    level: "Partner, with ad account Advertiser access",
    accountIdLabel: "Your Business Manager ID",
    helpUrl: "https://www.facebook.com/business/help/1717412048538897",
    critical: true,
  },
  facebook: {
    key: "access_facebook_page",
    platform: "Facebook Page",
    title: "Facebook Page access",
    steps: "If your Page is already in Meta Business Manager, sharing it with our partner ID covers this. Otherwise: Page settings → Page access → Add new → invite the email in your welcome email with Task access.",
    level: "Task access (content, messages, ads)",
    accountIdLabel: "Page URL",
  },
  instagram: {
    key: "access_instagram",
    platform: "Instagram",
    title: "Instagram account access",
    steps: "Connect Instagram to your Facebook Page or Business Manager (Settings → Accounts → Instagram accounts), then share it with our partner ID.",
    level: "Partner access through Business Manager",
    accountIdLabel: "Instagram handle",
  },
  google_ads: {
    key: "access_google_ads",
    platform: "Google Ads",
    title: "Google Ads access",
    steps:
      "1. Sign in to ads.google.com.\n2. Go to Admin → Access and security → Managers.\n3. Accept the link request from our manager account (MCC), or click + and enter the manager account ID from your welcome email.",
    level: "Standard access via manager-account link",
    accountIdLabel: "Your Google Ads customer ID (123-456-7890)",
    helpUrl: "https://support.google.com/google-ads/answer/7459601",
    critical: true,
  },
  ga4: {
    key: "access_google_analytics",
    platform: "Google Analytics",
    title: "Google Analytics access",
    steps: "In GA4: Admin → Account access management → + → Add users → enter the email in your welcome email and choose Editor.",
    level: "Editor",
    accountIdLabel: "GA4 property ID",
  },
  gtm: {
    key: "access_google_tag_manager",
    platform: "Google Tag Manager",
    title: "Google Tag Manager access",
    steps: "In Tag Manager: Admin → User Management → + → Add users → enter the email in your welcome email with Publish permission on your container.",
    level: "Publish",
    accountIdLabel: "Container ID (GTM-XXXX)",
  },
  search_console: {
    key: "access_search_console",
    platform: "Google Search Console",
    title: "Google Search Console access",
    steps: "In Search Console: Settings → Users and permissions → Add user → enter the email in your welcome email with Full permission.",
    level: "Full user",
  },
  cms: {
    key: "access_website_cms",
    platform: "Website / CMS",
    title: "Website / CMS access",
    steps: "Create a new user for us in your website platform (WordPress, Webflow, Shopify, Squarespace or Wix) using the email in your welcome email. Choose an Editor or Staff role. Don't share your own login.",
    level: "Editor / staff account",
    accountIdLabel: "Website platform",
  },
  crm: {
    key: "access_crm",
    platform: "CRM",
    title: "CRM access",
    steps: "Invite the email in your welcome email as a user in your CRM (HubSpot, Salesforce, Pipedrive, GoHighLevel…) with read access to leads and pipelines.",
    level: "Read-only user",
    required: false,
    accountIdLabel: "Which CRM do you use?",
  },
  email: {
    key: "access_email_platform",
    platform: "Email platform",
    title: "Email marketing platform access",
    steps: "Invite the email in your welcome email as a team member in your email tool (Klaviyo, Mailchimp, etc.) with Manager or Campaign permissions.",
    level: "Manager",
    required: false,
    accountIdLabel: "Which email platform do you use?",
  },
  dns: {
    key: "access_domain_dns",
    platform: "Domain / DNS",
    title: "Domain and DNS access",
    steps: "Add us as a delegate or team member in your domain registrar (GoDaddy, Namecheap, Cloudflare…) using the email in your welcome email. If your registrar doesn't support delegates, we'll schedule a screen-share instead.",
    level: "Delegate / DNS editor",
    accountIdLabel: "Registrar",
  },
};

function accessItem(spec: AccessSpec): TemplateItem {
  return {
    key: spec.key,
    kind: "access",
    title: spec.title,
    audience: "client",
    required: spec.required ?? true,
    critical: spec.critical ?? false,
    weight: 3,
    category: "access",
    dueOffsetDays: 5,
    access: {
      platform: spec.platform,
      instructions: spec.steps + ACCESS_FOOTER,
      accessLevel: spec.level,
      accountIdLabel: spec.accountIdLabel,
      helpUrl: spec.helpUrl,
    },
  };
}

const accountAccess = (platforms: (keyof typeof ACCESS)[]): Section => ({
  key: "access",
  title: "Account access",
  description: DELEGATED_NOTE,
  items: platforms.map((p) => accessItem(ACCESS[p])),
});

function kickoffReadiness(accessKeys: string[], opts: { creativeReview: boolean }): Section {
  const items: TemplateItem[] = [
    {
      key: "assign_owner",
      kind: "task",
      title: "Internal owner and delivery team assigned",
      audience: "internal",
      required: true,
      dueOffsetDays: 1,
      assignee: { type: "onboarding_owner" },
    },
    {
      key: "verify_access",
      kind: "task",
      title: "Required platform access confirmed",
      description: "Check each platform shows our access at the agreed level.",
      audience: "internal",
      required: true,
      dueAfterDependencyDays: 1,
      dueOffsetDays: 7,
      assignee: { type: "onboarding_owner" },
      dependsOn: accessKeys,
    },
  ];
  if (opts.creativeReview)
    items.push({
      key: "final_creative_review",
      kind: "task",
      title: "Final creative review",
      description: "Starts once the logo files and brand guide are approved and the creative questionnaire is complete.",
      audience: "internal",
      required: true,
      dueAfterDependencyDays: 2,
      dueOffsetDays: 8,
      assignee: { type: "onboarding_owner" },
      dependsOn: ["logo_files", "brand_guidelines", "creative_questionnaire"],
    });
  items.push(
    {
      key: "kickoff_prefs",
      kind: "form",
      title: "Kickoff call availability",
      audience: "client",
      required: true,
      weight: 2,
      dueOffsetDays: 6,
      fields: [
        { key: "dates", label: "Dates and times that work for a 60-minute kickoff", type: "textarea", required: true },
        { key: "attendees", label: "Who will attend from your side?", type: "textarea", required: true },
      ],
    },
    {
      key: "kickoff_date",
      kind: "task",
      title: "Kickoff date confirmed",
      audience: "internal",
      required: true,
      dueAfterDependencyDays: 1,
      dueOffsetDays: 8,
      assignee: { type: "onboarding_owner" },
      dependsOn: ["kickoff_prefs"],
    },
    {
      key: "final_approval",
      kind: "task",
      title: "Final staff approval",
      description: "All required forms complete, required files approved and platform access confirmed.",
      audience: "internal",
      required: true,
      dueAfterDependencyDays: 1,
      dueOffsetDays: 10,
      assignee: { type: "onboarding_owner" },
      dependsOn: ["verify_access", "kickoff_date", "business_profile", "goals_audience", "project_scope", ...(opts.creativeReview ? ["final_creative_review"] : [])],
    },
  );
  return { key: "kickoff", title: "Kickoff readiness", description: "Internal checks before the delivery team starts.", items };
}

const SERVICES = ["Paid ads", "SEO", "Website", "Social media", "Email marketing", "Content", "Analytics"];

function agencyWorkflow(name: string, description: string, platforms: (keyof typeof ACCESS)[], opts: { creative: boolean; fullBrand: boolean }): LibraryTemplate {
  const access = accountAccess(platforms);
  const accessKeys = access.items.filter((i) => i.required).map((i) => i.key);
  const sections = [businessDetails(), goals()];
  if (opts.creative) sections.push(brandAssets({ full: opts.fullBrand }));
  sections.push(contacts(), projectRequirements(SERVICES), access, kickoffReadiness(accessKeys, { creativeReview: opts.creative }));
  return { name, description, category: "agency", content: { sections } };
}

export const FULL_SERVICE_TEMPLATE = agencyWorkflow(
  "Full-Service Client",
  "Complete agency intake: business details, goals, brand assets, contacts, project requirements, platform access and kickoff readiness.",
  ["meta", "facebook", "instagram", "google_ads", "ga4", "gtm", "cms", "crm", "email"],
  { creative: true, fullBrand: true },
);

export const PAID_ADS_TEMPLATE = agencyWorkflow(
  "Paid Ads Client",
  "Google and Meta advertising clients: offer, targeting, creative and ad-account access.",
  ["meta", "facebook", "instagram", "google_ads", "ga4", "gtm"],
  { creative: true, fullBrand: true },
);

export const SEO_TEMPLATE = agencyWorkflow(
  "SEO Client",
  "Search clients: business details, goals, website, analytics and Search Console access.",
  ["ga4", "gtm", "search_console", "cms"],
  { creative: false, fullBrand: false },
);

export const WEBSITE_TEMPLATE = agencyWorkflow(
  "Website Client",
  "Website builds: brand assets, content, CMS, domain and analytics access.",
  ["cms", "dns", "ga4", "gtm"],
  { creative: true, fullBrand: true },
);

export const SOCIAL_TEMPLATE = agencyWorkflow(
  "Social Media Client",
  "Organic social clients: brand voice, creative and Meta/Instagram access.",
  ["meta", "facebook", "instagram"],
  { creative: true, fullBrand: true },
);

/** Default agency template (used by tests and the "Full-Service" demo workflow). */
export const AGENCY_TEMPLATE = FULL_SERVICE_TEMPLATE;

export const AGENCY_WORKFLOWS = [FULL_SERVICE_TEMPLATE, PAID_ADS_TEMPLATE, SEO_TEMPLATE, WEBSITE_TEMPLATE, SOCIAL_TEMPLATE];

export const ACCOUNTING_TEMPLATE: LibraryTemplate = {
  name: "Accounting firm: new client (starter)",
  description: "Example of the same engine configured for a bookkeeping and tax client.",
  category: "accounting",
  content: {
    sections: [
      {
        key: "engagement",
        title: "Engagement",
        items: [
          {
            key: "engagement_letter",
            kind: "signature",
            category: "legal",
            critical: true,
            title: "Engagement letter",
            audience: "client",
            required: true,
            dueOffsetDays: 5,
            signature: {
              provider: "External e-signature provider",
              instructions: "Sign the engagement letter sent by email. Staff confirm receipt of the signed copy here.",
            },
          },
          {
            key: "entity_details",
            kind: "form",
            title: "Entity details",
            audience: "client",
            required: true,
            dueOffsetDays: 5,
            fields: [
              { key: "legal_name", label: "Legal entity name", type: "text", required: true },
              {
                key: "entity_type",
                label: "Entity type",
                type: "select",
                required: true,
                options: ["Sole proprietor", "LLC", "S corporation", "C corporation", "Partnership", "Non-profit"],
              },
              { key: "fiscal_year_end", label: "Fiscal year end", type: "date", required: true },
            ],
          },
        ],
      },
      {
        key: "records",
        title: "Records",
        items: [
          {
            key: "prior_returns",
            kind: "file",
            category: "tax",
            title: "Prior two years of tax returns",
            audience: "client",
            required: true,
            dueOffsetDays: 10,
            file: { accept: ["pdf"], maxSizeMb: 25, maxFiles: 4 },
          },
          {
            key: "bank_statements",
            kind: "file",
            category: "financial",
            title: "Last three months of bank statements",
            audience: "client",
            required: true,
            dueOffsetDays: 10,
            file: { accept: ["pdf", "csv", "xlsx"], maxSizeMb: 25, maxFiles: 12 },
          },
          {
            key: "bookkeeping_access",
            kind: "checklist",
            title: "Bookkeeping software access",
            description: DELEGATED_NOTE,
            audience: "client",
            required: true,
            dueOffsetDays: 7,
            checklist: [
              { key: "accountant_invite", label: "Invite us as your accountant user", help: "Use the accountant invite feature in your bookkeeping software." },
              { key: "bank_feed", label: "Confirm bank feeds are connected", help: "Connect feeds through the software's bank connection, not by sharing bank logins." },
            ],
          },
        ],
      },
      {
        key: "setup",
        title: "Internal setup",
        items: [
          {
            key: "conflict_check",
            kind: "task",
            title: "Run conflict check",
            audience: "internal",
            required: true,
            dueOffsetDays: 2,
            assignee: { type: "onboarding_owner" },
          },
          {
            key: "review_records",
            kind: "task",
            title: "Review records and set up client file",
            audience: "internal",
            required: true,
            dueOffsetDays: 14,
            assignee: { type: "onboarding_owner" },
            dependsOn: ["prior_returns", "bank_statements", "entity_details"],
          },
        ],
      },
    ],
  },
};

export const BLANK_TEMPLATE: TemplateContent = {
  sections: [
    {
      key: "basics",
      title: "Basics",
      items: [
        {
          key: "company_info",
          kind: "form",
          title: "Company information",
          audience: "client",
          required: true,
          dueOffsetDays: 5,
          fields: [{ key: "legal_name", label: "Legal company name", type: "text", required: true }],
        },
      ],
    },
  ],
};
