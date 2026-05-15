import { describe, expect, it } from "vitest";
import { fingerprintErrorLog, normalizeForFingerprint } from "../src/lib/fingerprint.ts";
import type { StoredLog } from "../src/storage/logs.ts";

// The fingerprint module is the only path-independent piece of error
// handling — Mongo isn't involved. We exercise it as a pure unit so this
// suite stays runnable everywhere.

function log(overrides: Partial<StoredLog> = {}): StoredLog {
  return {
    ts: new Date("2026-05-14T12:00:00Z"),
    meta: { service: "kioku-api", component: "api", env: "test", level: "error" },
    ...overrides,
  };
}

describe("normalizeForFingerprint", () => {
  it("replaces ISO timestamps with <ts>", () => {
    expect(normalizeForFingerprint("started at 2026-05-14T12:00:00Z and finished")).toBe(
      "started at <ts> and finished",
    );
  });

  it("replaces UUIDs with <uuid>", () => {
    expect(normalizeForFingerprint("session a1b2c3d4-e5f6-7890-abcd-ef1234567890 closed")).toBe(
      "session <uuid> closed",
    );
  });

  it("replaces Mongo ObjectIds with <id>", () => {
    expect(normalizeForFingerprint("fact 507f1f77bcf86cd799439011 missing")).toBe(
      "fact <id> missing",
    );
  });

  it("replaces long numeric runs with <n>", () => {
    expect(normalizeForFingerprint("user 1234567 hit limit")).toBe("user <n> hit limit");
  });

  it("leaves short numbers alone (status codes, counts)", () => {
    expect(normalizeForFingerprint("got HTTP 503")).toBe("got HTTP 503");
  });
});

describe("fingerprintErrorLog", () => {
  it("returns undefined when there is no signal to hash on", () => {
    expect(fingerprintErrorLog(log({ msg: undefined }))).toBeUndefined();
  });

  it("hashes from the top-level msg when fields are empty", () => {
    const fp = fingerprintErrorLog(log({ msg: "ingest tick failed" }));
    expect(fp?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fp?.message).toBe("ingest tick failed");
  });

  it("prefers a structured err object over msg", () => {
    const fp = fingerprintErrorLog(
      log({
        msg: "kioku ingest failed",
        fields: {
          err: {
            name: "TypeError",
            message: "Cannot read properties of undefined (reading 'foo')",
            stack: "TypeError: Cannot read…\n    at handle (/app/src/ingest.ts:12:5)",
          },
        },
      }),
    );
    expect(fp?.name).toBe("TypeError");
    expect(fp?.message).toContain("Cannot read properties");
    expect(fp?.sampleStack).toContain("at handle");
  });

  it("accepts a flat string err field", () => {
    const fp = fingerprintErrorLog(log({ fields: { err: "ECONNREFUSED 127.0.0.1:1234" } }));
    expect(fp?.message).toBe("ECONNREFUSED 127.0.0.1:1234");
  });

  it("groups occurrences with varying IDs to the same fingerprint", () => {
    const a = fingerprintErrorLog(log({ msg: "ingest 507f1f77bcf86cd799439011 failed" }));
    const b = fingerprintErrorLog(log({ msg: "ingest 507f1f77bcf86cd799439099 failed" }));
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it("distinguishes errors from different services", () => {
    const k = fingerprintErrorLog(
      log({
        msg: "tick failed",
        meta: { service: "kioku-api", component: "api", env: "test", level: "error" },
      }),
    );
    const z = fingerprintErrorLog(
      log({
        msg: "tick failed",
        meta: { service: "kizuna-api", component: "api", env: "test", level: "error" },
      }),
    );
    expect(k?.fingerprint).not.toBe(z?.fingerprint);
  });

  it("is deterministic across calls", () => {
    const a = fingerprintErrorLog(log({ msg: "boom" }));
    const b = fingerprintErrorLog(log({ msg: "boom" }));
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });

  it("distinguishes errors with different cause chains", () => {
    const a = fingerprintErrorLog(
      log({
        fields: {
          err: {
            name: "WrapperError",
            message: "operation failed",
            cause: { name: "ECONNREFUSED", message: "connection refused" },
          },
        },
      }),
    );
    const b = fingerprintErrorLog(
      log({
        fields: {
          err: {
            name: "WrapperError",
            message: "operation failed",
            cause: { name: "ETIMEDOUT", message: "request timed out" },
          },
        },
      }),
    );
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });

  it("AggregateError-shaped errors include the first inner error in the signature", () => {
    const a = fingerprintErrorLog(
      log({
        fields: {
          err: {
            name: "AggregateError",
            message: "All promises rejected",
            errors: [{ name: "TypeError", message: "boom A" }],
          },
        },
      }),
    );
    const b = fingerprintErrorLog(
      log({
        fields: {
          err: {
            name: "AggregateError",
            message: "All promises rejected",
            errors: [{ name: "RangeError", message: "boom B" }],
          },
        },
      }),
    );
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });
});
