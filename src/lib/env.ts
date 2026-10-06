// Central place for runtime configuration. Everything optional has an honest fallback.
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/clientflow",
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "claude-opus-5-5",
  clamavHost: process.env.CLAMAV_HOST ?? "",
  clamavPort: Number(process.env.CLAMAV_PORT ?? 3310),
  cronSecret: process.env.CRON_SECRET ?? "",
  isProduction: process.env.NODE_ENV === "production",
};

export function assertProductionConfig() {
  if (env.isProduction && env.sessionSecret.startsWith("dev-only")) {
    throw new Error("SESSION_SECRET must be set in production");
  }
}
