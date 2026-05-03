import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(envKey: string | undefined): Buffer {
  if (!envKey) {
    throw new Error(
      'KIZUNA_OAUTH_ENCRYPTION_KEY is not set; required to encrypt OAuth tokens',
    );
  }
  const buf = Buffer.from(envKey, 'base64');
  if (buf.length !== 32) {
    throw new Error('KIZUNA_OAUTH_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buf;
}

export function encrypt(plaintext: string, envKey?: string): string {
  const key = loadKey(envKey ?? process.env.KIZUNA_OAUTH_ENCRYPTION_KEY);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(envelope: string, envKey?: string): string {
  const key = loadKey(envKey ?? process.env.KIZUNA_OAUTH_ENCRYPTION_KEY);
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('invalid encryption envelope');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
