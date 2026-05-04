import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'kizuna_session';
const TTL_MS = 30 * 86_400_000; // 30 days

function secret(): string {
  return process.env.KIZUNA_API_KEY ?? '';
}

function hmac(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function makeSessionToken(): string {
  const nonce = randomBytes(16).toString('base64url');
  const ts = Date.now();
  const payload = `${nonce}.${ts}`;
  return `${payload}.${hmac(payload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!nonce || !ts || !sig) return false;
  const expected = hmac(`${nonce}.${ts}`);
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return false;
    }
  } catch {
    return false;
  }
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age)) return false;
  return age >= 0 && age < TTL_MS;
}

export function checkApiKey(provided: string): boolean {
  const expected = secret();
  if (!expected || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(provided, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}
