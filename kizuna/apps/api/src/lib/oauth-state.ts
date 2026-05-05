import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless CSRF state token.
// Format: <base64url(nonce||":"||tsSeconds)>.<base64url(hmac_sha256(secret, payload))>
// Verified by recomputing the HMAC + checking the timestamp is within TTL.

const NONCE_BYTES = 16;
const DEFAULT_TTL_SEC = 600;

function hmac(secret: string, payload: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function makeState(secret: string, nowMs: number = Date.now()): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ts = Math.floor(nowMs / 1000);
  const payload = Buffer.concat([nonce, Buffer.from(`:${ts}`)]);
  const sig = hmac(secret, payload);
  return `${payload.toString("base64url")}.${sig.toString("base64url")}`;
}

export function verifyState(
  secret: string,
  state: string,
  opts: { ttlSec?: number; nowMs?: number } = {},
): boolean {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);

  const parts = state.split(".");
  if (parts.length !== 2) return false;
  const [b64Payload, b64Sig] = parts;
  if (!b64Payload || !b64Sig) return false;

  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(b64Payload, "base64url");
    sig = Buffer.from(b64Sig, "base64url");
  } catch {
    return false;
  }
  if (payload.length <= NONCE_BYTES) return false;

  const expected = hmac(secret, payload);
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(sig, expected)) return false;

  const text = payload.subarray(NONCE_BYTES).toString("utf8");
  if (!text.startsWith(":")) return false;
  const ts = Number(text.slice(1));
  if (!Number.isFinite(ts)) return false;
  const age = nowSec - ts;
  return age >= 0 && age <= ttlSec;
}
