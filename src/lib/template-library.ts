import type { TemplateContent } from "./templates";

const DELEGATED_NOTE =
  "Never send us passwords. Each step gives our team its own access through the platform's sharing settings, which you can remove at any time.";

export const AGENCY_TEMPLATE: { name: string; description: string; category: string; content: TemplateContent } = {
  name: "Marketing agency onboarding",
  description: "Standard intake for new retainer and project clients: business details, goals, brand, access and kickoff.",
  category: "agency",
  content: {
    sections: [
      {
        key: "business",
        title: "Business details",
        description: "The basics we need to set up your account and invoices.",
        items: [
          {
            key: "business_profile",
            kind: "form",
            title: "Company profile",
            audience: "client",
            required: true,
            dueOffsetDays: 3,
            fields: [
              { key: "legal_name", label: "Legal company name", type: "text", required: true },
              { key: "trading_name", label: "Trading name (if different)", type: "text", required: false },
              { key: "website", label: "Website", type: "url", required: true },
              {
                key: "industry",
                label: "Industry",
                type: "select",
                required: true,
                options: ["E-commerce", "SaaS", "Professional services", "Hospitality", "Healthcare", "Non-profit", "Other"],
              },
              {
                key: "team_size",
                label: "Team size",
                type: "select",
                required: false,
                options: ["1-10", "11-50", "51-200", "201-1000", "1000+"],
              },
              { key: "address", label: "Business address", type: "textarea", required: true },
              { key: "billing_email", label: "Billing email", type: "email", required: true },
            ],
          },
        ],
      },
      {
        key: "goals",
        title: "Goals and target audience",
        items: [
          {
            key: "goals_audience",
            kind: "form",
            title: "Goals and audience",
            description: "Help us understand what success looks like for you.",
            audience: "client",
            required: true,
            dueOffsetDays: 5,
            fields: [
              { key: "primary_goal", label: "What is the main goal for the next 6 months?", type: "textarea", required: true },
              { key: "kpis", label: "How will you measure success? (KPIs)", type: "textarea", required: true },
              { key: "audience", label: "Describe your ideal customer", type: "textarea", required: true },
              { key: "competitors", label: "Main competitors (one per line)", type: "textarea", required: false },
              {
                key: "channels",
                label: "Channels you use today",
                type: "multiselect",
                required: false,
                options: ["Paid search", "Paid social", "SEO", "Email", "Organic social", "Events", "Partnerships"],
              },
            ],
          },
        ],
      },
      {
        key: "brand",
        title: "Brand assets",
        items: [
          {
            key: "logo_files",
            kind: "file",
            title: "Logo files",
            description: "Vector files (SVG, EPS or AI) are best. PNGs with transparent backgrounds also work.",
            audience: "client",
            required: true,
            dueOffsetDays: 5,
            file: { accept: ["svg", "png", "eps", "ai", "pdf"], maxSizeMb: 25, maxFiles: 10 },
          },
          {
            key: "brand_guidelines",
            kind: "file",
            title: "Brand guidelines",
            description: "Your brand book or style guide, if you have one.",
            audience: "client",
            required: false,
            dueOffsetDays: 7,
            file: { accept: ["pdf", "docx", "pptx", "key"], maxSizeMb: 50, maxFiles: 3 },
          },
          {
            key: "brand_voice",
            kind: "form",
            title: "Colors, fonts and voice",
            audience: "client",
            required: false,
            dueOffsetDays: 7,
            fields: [
              { key: "colors", label: "Brand colors (hex codes)", type: "text", required: false },
              { key: "fonts", label: "Fonts", type: "text", required: false },
              { key: "voice", label: "Three words that describe your brand voice", type: "text", required: false },
            ],
          },
        ],
      },
      {
        key: "contacts",
        title: "Main contacts",
        items: [
          {
            key: "contacts",
            kind: "form",
            title: "Who we should work with",
            audience: "client",
            required: true,
            dueOffsetDays: 3,
            fields: [
              { key: "primary_name", label: "Day-to-day contact name", type: "text", required: true },
              { key: "primary_email", label: "Day-to-day contact email", type: "email", required: true },
              { key: "primary_phone", label: "Day-to-day contact phone", type: "phone", required: false },
              { key: "approver_name", label: "Final approver name", type: "text", required: true },
              { key: "approver_email", label: "Final approver email", type: "email", required: true },
              {
                key: "channel",
                label: "Preferred way to reach you",
                type: "select",
                required: false,
                options: ["Email", "Phone", "Slack Connect", "Microsoft Teams"],
              },
            ],
          },
        ],
      },
      {
        key: "requirements",
        title: "Project requirements",
        items: [
          {
            key: "project_scope",
            kind: "form",
            title: "Scope and requirements",
            audience: "client",
            required: true,
            dueOffsetDays: 7,
            dependsOn: ["goals_audience"],
            fields: [
              {
                key: "services",
                label: "Services you're engaging us for",
                type: "multiselect",
                required: true,
                options: ["Paid media", "SEO", "Content", "Social", "Web design", "Email marketing", "Analytics"],
              },
              { key: "launch_date", label: "Target launch date", type: "date", required: false },
              { key: "must_haves", label: "Must-haves for the first 90 days", type: "textarea", required: true },
              { key: "constraints", label: "Constraints we should know about (legal review, approvals)", type: "textarea", required: false },
            ],
          },
          {
            key: "anything_else",
            kind: "question",
            title: "Anything else we should know?",
            description: "Past agency experiences, internal politics, seasonal peaks: anything that helps.",
            audience: "client",
            required: false,
          },
        ],
      },
      {
        key: "access",
        title: "Account access",
        description: DELEGATED_NOTE,
        items: [
          {
            key: "account_access",
            kind: "checklist",
            title: "Account access checklist",
            description: DELEGATED_NOTE,
            audience: "client",
            required: true,
            dueOffsetDays: 7,
            checklist: [
              {
                key: "ga4",
                label: "Google Analytics: add our team as Editor",
                help: "Admin > Property access management > + > Add users. Use the agency email shown in your welcome email.",
              },
              {
                key: "google_ads",
                label: "Google Ads: accept our manager account link",
                help: "We'll send a link request from our manager (MCC) account. Approve it under Admin > Access and security > Managers.",
              },
              {
                key: "meta",
                label: "Meta Business: add us as a partner",
                help: "Business settings > Users > Partners > Add, then enter our Business ID. Assign the ad account and pages.",
              },
              {
                key: "search_console",
                label: "Search Console: add our team as Full user",
                help: "Settings > Users and permissions > Add user.",
              },
              {
                key: "cms",
                label: "Website CMS: create a named account for us",
                help: "Create a separate Editor account for our team. Please don't share an existing login.",
              },
            ],
          },
          {
            key: "verify_access",
            kind: "task",
            title: "Verify all platform access works",
            audience: "internal",
            required: true,
            dueOffsetDays: 9,
            assignee: { type: "onboarding_owner" },
            dependsOn: ["account_access"],
          },
        ],
      },
      {
        key: "kickoff",
        title: "Kickoff readiness",
        items: [
          {
            key: "sow_signature",
            kind: "signature",
            title: "Signed statement of work",
            description: "Sign the statement of work we sent through our e-signature provider.",
            audience: "client",
            required: true,
            dueOffsetDays: 5,
            signature: {
              provider: "External e-signature provider",
              instructions:
                "Sign using the link in the e-signature email. We'll confirm here once the signed copy reaches us. Ticking a box here is not a legal signature.",
            },
          },
          {
            key: "review_brief",
            kind: "task",
            title: "Review intake and draft the brief",
            audience: "internal",
            required: true,
            dueOffsetDays: 10,
            assignee: { type: "onboarding_owner" },
            dependsOn: ["business_profile", "goals_audience", "project_scope"],
          },
          {
            key: "kickoff_prefs",
            kind: "form",
            title: "Kickoff call availability",
            audience: "client",
            required: true,
            dueOffsetDays: 10,
            fields: [
              { key: "attendees", label: "Who will attend from your side?", type: "textarea", required: true },
              { key: "availability", label: "Preferred days and times (with time zone)", type: "textarea", required: true },
            ],
          },
          {
            key: "schedule_kickoff",
            kind: "task",
            title: "Schedule kickoff call and send agenda",
            audience: "internal",
            required: true,
            dueOffsetDays: 12,
            assignee: { type: "onboarding_owner" },
            dependsOn: ["review_brief", "kickoff_prefs", "sow_signature"],
          },
        ],
      },
    ],
  },
};

export const ACCOUNTING_TEMPLATE: { name: string; description: string; category: string; content: TemplateContent } = {
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
            title: "Prior two years of tax returns",
            audience: "client",
            required: true,
            dueOffsetDays: 10,
            file: { accept: ["pdf"], maxSizeMb: 25, maxFiles: 4 },
          },
          {
            key: "bank_statements",
            kind: "file",
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
