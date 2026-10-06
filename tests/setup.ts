import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll } from "vitest";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/clientflow_test";
process.env.STORAGE_DIR = path.join(os.tmpdir(), `clientflow-test-${process.pid}`);
process.env.SESSION_SECRET = "test-secret-0123456789abcdef";
process.env.APP_URL = "http://localhost:3000";
delete process.env.RESEND_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAMAV_HOST;

beforeAll(async () => {
  const { migrate } = await import("../scripts/migrate");
  await migrate({ reset: true, quiet: true });
});

afterAll(async () => {
  const { pool } = await import("../src/lib/db");
  await pool.end();
});
