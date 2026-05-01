import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock mongoose at the module level. The other DB test files use real mongoose
// via `withTestDb()`; vitest mocks are per-file so this scope doesn't leak.
const { mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
}));
vi.mock("mongoose", () => ({
  default: {
    connect: mockConnect,
    disconnect: mockDisconnect,
  },
}));

// Silence the Pino logger.
vi.mock("@mashiro/shared", () => ({
  config: { MONGODB_URI: "mongodb://test-host:27017/mashiro-test" },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { connectDB, disconnectDB, isDuplicateKeyError } from "../src/connection";

class ProcessExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${String(code)})`);
    this.code = code;
  }
}

beforeEach(() => {
  mockConnect.mockReset();
  mockDisconnect.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectDB", () => {
  it("calls mongoose.connect with the configured URI on the happy path", async () => {
    mockConnect.mockResolvedValue(undefined);
    await connectDB();
    expect(mockConnect).toHaveBeenCalledWith("mongodb://test-host:27017/mashiro-test");
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("calls process.exit(1) when mongoose.connect rejects", async () => {
    // Mock process.exit to throw so we can detect the call without killing the
    // test runner. Same sentinel pattern as config.test.ts.
    let exitCode: number | undefined;
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new ProcessExitSentinel(code ?? 0);
    }) as never);
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(connectDB()).rejects.toThrow(ProcessExitSentinel);
    expect(exitCode).toBe(1);
  });
});

describe("disconnectDB", () => {
  it("calls mongoose.disconnect", async () => {
    mockDisconnect.mockResolvedValue(undefined);
    await disconnectDB();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("isDuplicateKeyError", () => {
  it("returns true for an Error with code === 11000", () => {
    const err = Object.assign(new Error("dup"), { code: 11000 });
    expect(isDuplicateKeyError(err)).toBe(true);
  });

  it("returns false for an Error with a different code", () => {
    const err = Object.assign(new Error("other"), { code: 12345 });
    expect(isDuplicateKeyError(err)).toBe(false);
  });

  it("returns false for an Error without a code", () => {
    expect(isDuplicateKeyError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError({ code: 11000 })).toBe(false);
    expect(isDuplicateKeyError("string")).toBe(false);
    expect(isDuplicateKeyError(11000)).toBe(false);
  });
});
