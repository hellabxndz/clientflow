import net from "node:net";
import { env } from "./env";

export type ScanResult = { status: "clean" | "infected" | "error" | "not_scanned"; detail?: string };

/**
 * File-scanning integration boundary. When CLAMAV_HOST is set, uploads are streamed to a clamd
 * daemon with the INSTREAM command. Without it, files are stored as "not_scanned" and the UI
 * shows a warning. Do not collect sensitive documents live until a scanner is configured.
 */
export interface Scanner {
  readonly name: string;
  readonly configured: boolean;
  scan(data: Buffer): Promise<ScanResult>;
}

class NoScanner implements Scanner {
  readonly name = "none";
  readonly configured = false;
  async scan(): Promise<ScanResult> {
    return { status: "not_scanned", detail: "No malware scanner configured" };
  }
}

class ClamAvScanner implements Scanner {
  readonly name = "clamav";
  readonly configured = true;
  constructor(private host: string, private port: number) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let reply = "";
      const done = (r: ScanResult) => {
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(30000, () => done({ status: "error", detail: "Scanner timed out" }));
      socket.on("error", (e) => done({ status: "error", detail: `Scanner unavailable: ${e.message}` }));
      socket.on("data", (chunk) => (reply += chunk.toString()));
      socket.on("end", () => {
        // zINSTREAM replies are NUL-terminated ("stream: OK\0"), which trim() doesn't remove.
        const text = reply.replace(/\0/g, "").trim();
        if (/FOUND$/.test(text)) done({ status: "infected", detail: text });
        else if (/^stream: OK$/.test(text)) done({ status: "clean" });
        else done({ status: "error", detail: text || "Empty scanner response" });
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        const chunkSize = 64 * 1024;
        for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.subarray(i, i + chunkSize);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

export function getScanner(): Scanner {
  return env.clamavHost ? new ClamAvScanner(env.clamavHost, env.clamavPort) : new NoScanner();
}

/**
 * End-to-end check of the configured scanner with the standard EICAR test string (harmless by design,
 * and detected by every antivirus engine). Passing means a real scanner answered and detected it.
 */
export async function testScanner(): Promise<{ ok: boolean; detail: string }> {
  const scanner = getScanner();
  if (!scanner.configured) return { ok: false, detail: "No scanner configured. Set CLAMAV_HOST." };
  const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "latin1");
  const [hit, clean] = [await scanner.scan(eicar), await scanner.scan(Buffer.from("ClientFlow scanner test: clean file"))];
  if (hit.status === "infected" && clean.status === "clean") return { ok: true, detail: `${scanner.name} detected the EICAR test file and passed a clean file.` };
  if (hit.status === "error" || clean.status === "error")
    return { ok: false, detail: (hit.status === "error" ? hit.detail : clean.detail) ?? "Scanner error" };
  return { ok: false, detail: `Unexpected result: test file ${hit.status}, clean file ${clean.status}.` };
}
