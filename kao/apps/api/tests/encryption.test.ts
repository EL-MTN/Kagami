import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/lib/encryption.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("encryption", () => {
  it("round-trips a refresh token", () => {
    const secret = "1//refresh-token-value";
    expect(decrypt(encrypt(secret, KEY), KEY)).toBe(secret);
  });

  it("produces a different envelope each time (random IV)", () => {
    expect(encrypt("x", KEY)).not.toBe(encrypt("x", KEY));
  });

  it("throws decrypting with the wrong key", () => {
    expect(() => decrypt(encrypt("x", KEY), OTHER_KEY)).toThrow();
  });

  it("throws on a tampered envelope", () => {
    const env = Buffer.from(encrypt("hello", KEY), "base64");
    const last = env.length - 1;
    env[last] = (env[last] ?? 0) ^ 0xff;
    expect(() => decrypt(env.toString("base64"), KEY)).toThrow();
  });

  it("rejects an undersized envelope", () => {
    expect(() => decrypt(Buffer.alloc(4).toString("base64"), KEY)).toThrow(
      /invalid encryption envelope/,
    );
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encrypt("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
