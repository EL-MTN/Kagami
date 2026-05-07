import { describe, expect, it } from "vitest";
import { makeState, verifyState } from "../src/lib/oauth-state.js";

describe("oauth-state", () => {
  it("verifies a freshly-issued state", () => {
    const s = makeState();
    expect(verifyState(s)).toBe(true);
  });

  it("rejects expired state", () => {
    const old = makeState(Date.now() - 700_000); // > 10 min ago
    expect(verifyState(old)).toBe(false);
  });

  it("rejects malformed state", () => {
    expect(verifyState("")).toBe(false);
    expect(verifyState("no-dot")).toBe(false);
    expect(verifyState(".empty-payload")).toBe(false);
    expect(verifyState("payload.")).toBe(false);
    expect(verifyState("a.b.c")).toBe(false);
  });

  it("rejects tampered signature", () => {
    const s = makeState();
    const [p, sig] = s.split(".");
    const flipped = sig!.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(verifyState(`${p}.${flipped}`)).toBe(false);
  });

  it("respects custom ttl", () => {
    const s = makeState(Date.now() - 10_000); // 10s ago
    expect(verifyState(s, { ttlSec: 5 })).toBe(false);
    expect(verifyState(s, { ttlSec: 30 })).toBe(true);
  });
});
