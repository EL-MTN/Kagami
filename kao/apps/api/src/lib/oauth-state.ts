import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless CSRF state token for the Google OAuth callback. Ported from
// Kizuna's apps/api/src/lib/oauth-state.ts, extended to BIND the grant name
// into the signed payload. Kao has one shared callback (so only one redirect
// URI is registered in Google Cloud); the grant being authorized travels in
// state. Binding it under the HMAC means a callback can't be replayed against
// a different grant than the one the start request initiated.
//
// Format: <base64url(nonce(16) ‖ ":" ‖ tsSeconds ‖ ":" ‖ grant)>.<base64url(hmac_sha256(secret, payload))>
//
// The HMAC secret is generated once per process at module load. Restarting
// the API invalidates any in-flight consent flows; the operator re-clicks
// "Connect".

const NONCE_BYTES = 16;
const DEFAULT_TTL_SEC = 600;

const SECRET = randomBytes(32);

function hmac(payload: Buffer): Buffer {
  return createHmac("sha256", SECRET).update(payload).digest();
}

export function makeState(grant: string, nowMs: number = Date.now()): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ts = Math.floor(nowMs / 1000);
  const payload = Buffer.concat([nonce, Buffer.from(`:${ts}:${grant}`)]);
  const sig = hmac(payload);
  return `${payload.toString("base64url")}.${sig.toString("base64url")}`;
}

export type StateResult = { ok: true; grant: string } | { ok: false };

export function verifyState(
  state: string,
  opts: { ttlSec?: number; nowMs?: number } = {},
): StateResult {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);

  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false };
  const [b64Payload, b64Sig] = parts;
  if (!b64Payload || !b64Sig) return { ok: false };

  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(b64Payload, "base64url");
    sig = Buffer.from(b64Sig, "base64url");
  } catch {
    return { ok: false };
  }
  if (payload.length <= NONCE_BYTES) return { ok: false };

  const expected = hmac(payload);
  if (sig.length !== expected.length) return { ok: false };
  if (!timingSafeEqual(sig, expected)) return { ok: false };

  // payload after the nonce is ":<ts>:<grant>". Grant names are simple
  // identifiers (no colon), so split on the first two colons.
  const text = payload.subarray(NONCE_BYTES).toString("utf8");
  if (!text.startsWith(":")) return { ok: false };
  const rest = text.slice(1);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return { ok: false };
  const tsStr = rest.slice(0, firstColon);
  const grant = rest.slice(firstColon + 1);
  if (!grant) return { ok: false };
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return { ok: false };
  const age = nowSec - ts;
  if (age < 0 || age > ttlSec) return { ok: false };
  return { ok: true, grant };
}
