import crypto from "node:crypto";
import { env } from "../env";

/**
 * Integration credentials are encrypted at rest with AES-256-GCM. The key comes from
 * INTEGRATION_ENCRYPTION_KEY (recommended) or, as a development fallback, is derived from
 * SESSION_SECRET. Rotating the key requires re-entering credentials.
 */
function key() {
  const material = env.integrationKey || `${env.sessionSecret}:integrations`;
  return crypto.createHash("sha256").update(material).digest();
}

export const usingFallbackKey = () => !env.integrationKey;

export function encryptSecrets(data: Record<string, string>) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecrets(blob: string | null): Record<string, string> {
  if (!blob) return {};
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown credential format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}

export function hmacSha256(secret: string, payload: string | Buffer, encoding: "hex" | "base64" = "hex") {
  return crypto.createHmac("sha256", secret).update(payload).digest(encoding);
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
