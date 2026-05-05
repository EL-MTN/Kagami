import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/lib/encryption.js";

const KEY = randomBytes(32).toString("base64");

describe("encryption", () => {
  it("roundtrips a string", () => {
    const out = decrypt(encrypt("hello world", KEY), KEY);
    expect(out).toBe("hello world");
  });

  it("produces a different envelope each time (random IV)", () => {
    const a = encrypt("same input", KEY);
    const b = encrypt("same input", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("same input");
    expect(decrypt(b, KEY)).toBe("same input");
  });

  it("rejects a tampered ciphertext", () => {
    const env = encrypt("secret", KEY);
    const buf = Buffer.from(env, "base64");
    // Flip a bit in the ciphertext (well past the IV+tag).
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const env = encrypt("secret", KEY);
    const wrong = randomBytes(32).toString("base64");
    expect(() => decrypt(env, wrong)).toThrow();
  });

  it("rejects an undersized envelope", () => {
    expect(() => decrypt("AAAA", KEY)).toThrow(/invalid encryption envelope/);
  });

  it("throws when the key is missing", () => {
    expect(() => encrypt("x", undefined)).toThrow(/KIZUNA_OAUTH_ENCRYPTION_KEY/);
  });

  it("throws when the key is the wrong length", () => {
    const tooShort = Buffer.alloc(16).toString("base64");
    expect(() => encrypt("x", tooShort)).toThrow(/32 bytes/);
  });
});
