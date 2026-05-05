import { describe, expect, it } from "vitest";
import { makeState, verifyState } from "../src/lib/oauth-state.js";

const SECRET = "a-secret-of-meaningful-length-12345";

describe("oauth-state", () => {
  it("verifies a freshly-issued state", () => {
    const s = makeState(SECRET);
    expect(verifyState(SECRET, s)).toBe(true);
  });

  it("rejects state signed by a different secret", () => {
    const s = makeState(SECRET);
    expect(verifyState("different-secret-of-meaningful-length", s)).toBe(false);
  });

  it("rejects expired state", () => {
    const old = makeState(SECRET, Date.now() - 700_000); // > 10 min ago
    expect(verifyState(SECRET, old)).toBe(false);
  });

  it("rejects malformed state", () => {
    expect(verifyState(SECRET, "")).toBe(false);
    expect(verifyState(SECRET, "no-dot")).toBe(false);
    expect(verifyState(SECRET, ".empty-payload")).toBe(false);
    expect(verifyState(SECRET, "payload.")).toBe(false);
    expect(verifyState(SECRET, "a.b.c")).toBe(false);
  });

  it("rejects tampered signature", () => {
    const s = makeState(SECRET);
    const [p, sig] = s.split(".");
    const flipped = sig!.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(verifyState(SECRET, `${p}.${flipped}`)).toBe(false);
  });

  it("respects custom ttl", () => {
    const s = makeState(SECRET, Date.now() - 10_000); // 10s ago
    expect(verifyState(SECRET, s, { ttlSec: 5 })).toBe(false);
    expect(verifyState(SECRET, s, { ttlSec: 30 })).toBe(true);
  });
});
