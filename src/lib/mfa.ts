import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { sysQuery, withSysTx } from "./db";
import { decryptSecrets, encryptSecrets } from "./integrations/crypto";

/**
 * Authenticator-app MFA (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), implemented with
 * node:crypto. Secrets are encrypted at rest; accepted steps are recorded so a code can't be replayed;
 * recovery codes are single-use and stored as bcrypt hashes.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** Returns the matching step (allowing one step of clock drift either way), or null. */
export function matchTotp(secret: string, code: string, now = Date.now()) {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    const expected = totpAt(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

export function otpauthUri(secret: string, email: string, issuer = "ClientFlow") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export async function qrSvg(uri: string) {
  return QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

export async function mfaEnabled(userId: string) {
  const [row] = await sysQuery<{ enabled: boolean }>("select enabled_at is not null as enabled from user_mfa where user_id = $1", [userId]);
  return row?.enabled ?? false;
}

/** Starts (or restarts) enrollment with a fresh secret. Not active until confirmed with a code. */
export async function beginEnrollment(userId: string) {
  if (await mfaEnabled(userId)) throw new Error("Two-step sign-in is already on. Turn it off first to set up a new device.");
  const secret = base32Encode(crypto.randomBytes(20));
  await sysQuery(
    `insert into user_mfa (user_id, secret_enc) values ($1, $2)
     on conflict (user_id) do update set secret_enc = excluded.secret_enc, enabled_at = null, last_step = 0, recovery_hashes = '{}'`,
    [userId, encryptSecrets({ secret })],
  );
  return secret;
}

export async function pendingSecret(userId: string) {
  const [row] = await sysQuery<{ secret_enc: string; enabled_at: Date | null }>("select secret_enc, enabled_at from user_mfa where user_id = $1", [userId]);
  if (!row || row.enabled_at) return null;
  return decryptSecrets(row.secret_enc).secret ?? null;
}

function newRecoveryCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

const hashCodes = (codes: string[]) => Promise.all(codes.map((c) => bcrypt.hash(c.replace(/-/g, ""), 10)));

/** Confirms enrollment with a code from the app. Returns recovery codes (shown once) or null if the code is wrong. */
export async function confirmEnrollment(userId: string, code: string) {
  return withSysTx(async (tx) => {
    const row = await tx.one<{ secret_enc: string; enabled_at: Date | null }>("select secret_enc, enabled_at from user_mfa where user_id = $1 for update", [userId]);
    if (!row || row.enabled_at) return null;
    const step = matchTotp(decryptSecrets(row.secret_enc).secret, code);
    if (step === null) return null;
    const codes = newRecoveryCodes();
    await tx.q("update user_mfa set enabled_at = now(), last_step = $2, recovery_hashes = $3 where user_id = $1", [userId, step, await hashCodes(codes)]);
    return codes;
  });
}

/**
 * Checks a sign-in code: a current authenticator code (each step accepted once) or an unused recovery code.
 * Returns how it was verified, or null.
 */
export async function verifyMfa(userId: string, input: string): Promise<"totp" | "recovery" | null> {
  return withSysTx(async (tx) => {
    const row = await tx.one<{ secret_enc: string; enabled_at: Date | null; last_step: string; recovery_hashes: string[] }>(
      "select secret_enc, enabled_at, last_step, recovery_hashes from user_mfa where user_id = $1 for update",
      [userId],
    );
    if (!row?.enabled_at) return null;
    const code = input.trim();
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      const step = matchTotp(decryptSecrets(row.secret_enc).secret, code);
      if (step === null || step <= Number(row.last_step)) return null;
      await tx.q("update user_mfa set last_step = $2 where user_id = $1", [userId, step]);
      return "totp";
    }
    const normalized = code.toLowerCase().replace(/[\s-]/g, "");
    if (normalized.length !== 10) return null;
    for (let i = 0; i < row.recovery_hashes.length; i++) {
      if (await bcrypt.compare(normalized, row.recovery_hashes[i])) {
        const remaining = row.recovery_hashes.filter((_, j) => j !== i);
        await tx.q("update user_mfa set recovery_hashes = $2 where user_id = $1", [userId, remaining]);
        return "recovery";
      }
    }
    return null;
  });
}

export async function recoveryCodesLeft(userId: string) {
  const [row] = await sysQuery<{ n: number }>("select coalesce(array_length(recovery_hashes, 1), 0)::int as n from user_mfa where user_id = $1", [userId]);
  return row?.n ?? 0;
}

export async function regenerateRecoveryCodes(userId: string) {
  const codes = newRecoveryCodes();
  const [row] = await sysQuery<{ user_id: string }>(
    "update user_mfa set recovery_hashes = $2 where user_id = $1 and enabled_at is not null returning user_id",
    [userId, await hashCodes(codes)],
  );
  return row ? codes : null;
}

export async function disableMfa(userId: string) {
  await sysQuery("delete from user_mfa where user_id = $1", [userId]);
}
