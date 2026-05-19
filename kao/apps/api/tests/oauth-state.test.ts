import { describe, expect, it } from "vitest";
import { makeState, verifyState } from "../src/lib/oauth-state.js";

describe("oauth-state", () => {
  it("round-trips and recovers the bound grant", () => {
    const r = verifyState(makeState("kokoro"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.grant).toBe("kokoro");
  });

  it("recovers distinct grants", () => {
    const a = verifyState(makeState("kizuna"));
    const b = verifyState(makeState("kokoro"));
    expect(a.ok && a.grant).toBe("kizuna");
    expect(b.ok && b.grant).toBe("kokoro");
  });

  it("rejects a tampered signature", () => {
    const s = makeState("kizuna");
    const [payload] = s.split(".");
    expect(verifyState(`${payload}.AAAA`).ok).toBe(false);
  });

  it("rejects a tampered grant (signature no longer matches)", () => {
    const s = makeState("kizuna");
    const [payload, sig] = s.split(".");
    const buf = Buffer.from(payload!, "base64url");
    // Flip a byte in the grant region (after the 16-byte nonce).
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff;
    expect(verifyState(`${buf.toString("base64url")}.${sig}`).ok).toBe(false);
  });

  it("rejects an expired state", () => {
    const old = makeState("kizuna", Date.now() - 3600_000);
    expect(verifyState(old, { ttlSec: 600 }).ok).toBe(false);
  });

  it("accepts within the TTL window", () => {
    const s = makeState("kizuna", Date.now() - 60_000);
    expect(verifyState(s, { ttlSec: 600 }).ok).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(verifyState("not-a-token").ok).toBe(false);
    expect(verifyState("a.b.c").ok).toBe(false);
    expect(verifyState("").ok).toBe(false);
  });
});
