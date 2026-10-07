import { describe, it, expect } from "vitest";
import { env } from "../src/lib/env";
import { getScanner, testScanner } from "../src/lib/scanning";

// Runs against a real clamd when CLAMAV_TEST_HOST is set (for example `docker compose up clamav`).
const host = process.env.CLAMAV_TEST_HOST;

describe.skipIf(!host)("ClamAV integration (live clamd)", () => {
  it("detects the EICAR test file and passes a clean file", async () => {
    env.clamavHost = host!;
    env.clamavPort = Number(process.env.CLAMAV_TEST_PORT ?? 3310);
    const result = await testScanner();
    expect(result.ok, result.detail).toBe(true);
    expect((await getScanner().scan(Buffer.from("%PDF-1.4 hello"))).status).toBe("clean");
    env.clamavHost = "";
  });
});

describe("scanner boundary", () => {
  it("without a scanner, nothing claims to be scanned", async () => {
    const saved = env.clamavHost;
    env.clamavHost = "";
    expect((await getScanner().scan(Buffer.from("x"))).status).toBe("not_scanned");
    expect((await testScanner()).ok).toBe(false);
    env.clamavHost = saved;
  });

  it("an unreachable scanner is an error, never clean", async () => {
    env.clamavHost = "127.0.0.1";
    env.clamavPort = 1;
    expect((await getScanner().scan(Buffer.from("x"))).status).toBe("error");
    env.clamavHost = "";
    env.clamavPort = 3310;
  });
});
