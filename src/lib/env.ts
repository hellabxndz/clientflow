import { z } from "zod";

// Central place for runtime configuration. Everything optional has an honest fallback.
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/clientflow",
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  integrationKey: process.env.INTEGRATION_ENCRYPTION_KEY ?? "",
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

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL").optional(),
  APP_URL: z.string().url("must be a full URL such as https://onboarding.example.com").optional(),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  INTEGRATION_ENCRYPTION_KEY: z.string().min(32, "must be at least 32 characters").optional(),
  EMAIL_FROM: z.string().regex(/<?[^\s@]+@[^\s@]+\.[^\s@]+>?$/, "must contain an email address").optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  CRON_SECRET: z.string().min(24, "must be at least 24 characters").optional(),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

/** Validates environment variables. Returns readable problems; production refuses to start on the critical ones. */
export function validateEnv(source: Record<string, string | undefined> = process.env) {
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(present);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`);
  const critical: string[] = [];
  if (source.NODE_ENV === "production") {
    if (!source.SESSION_SECRET) critical.push("SESSION_SECRET must be set in production");
    if (!source.DATABASE_URL) critical.push("DATABASE_URL must be set in production");
    if (!source.APP_URL) critical.push("APP_URL must be set in production");
  }
  return { problems, critical: [...critical, ...(source.NODE_ENV === "production" ? problems.filter((p) => p.startsWith("SESSION_SECRET")) : [])] };
}

export function assertProductionConfig() {
  const { problems, critical } = validateEnv();
  for (const p of problems) console.warn(`[config] ${p}`);
  if (critical.length) throw new Error(`Invalid configuration: ${critical.join("; ")}`);
}
