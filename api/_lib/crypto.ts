// Charles — hashing and token minting.
//
// Nothing that can be replayed is ever stored in plain text: login codes and
// connector tokens are kept as HMAC-SHA256 digests, peppered with
// SESSION_SECRET, so a leaked database row is not a working credential.

import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { env } from "./env.js";

/** HMAC-SHA256, hex. Peppered, so the digest is useless without the server secret. */
export function hashSecret(value: string): string {
  const pepper = env.SESSION_SECRET || "charles-unpeppered-dev-only";
  return createHmac("sha256", pepper).update(value).digest("hex");
}

/** A URL-safe random token. 32 bytes is far beyond guessable. */
export function mintToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A 6-digit numeric code, uniformly distributed (no modulo bias). */
export function mintNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  let n: number;
  do {
    n = randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % max).padStart(digits, "0");
}

/** Constant-time compare of two hex digests, safe against length mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Meta signs webhooks with the app secret over the RAW body bytes. */
export function metaSignature(rawBody: string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

/** Stable short id for logs and job de-duplication keys. */
export const shortHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
