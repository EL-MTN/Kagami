import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "../src/index";
import { newTraceContext, runWithTrace } from "../src/trace";

// End-to-end head sampling: a sampled-out trace flows trace.ts →
// the createLogger mixin (emits `sampled:false`) → the Kansoku shipper
// (drops below-warn, always ships warn+). This exercises the whole chain
// through the real factory, not a hand-rebuilt pino.

type FetchInit = { body: string };
let originalFetch: typeof globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: FetchInit) => Promise<Response>>>;

function shippedLines(): unknown[] {
  return fetchMock.mock.calls.flatMap((c) => JSON.parse(c[1].body) as unknown[]);
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it("ships warn+ but not below-warn lines from a sampled-out trace", async () => {
  const logger = createLogger({
    service: "samp",
    component: "test",
    env: "test",
    level: "debug",
    kansoku: { url: "https://api.kansoku.localhost", token: "t", batchSize: 1 },
  });

  runWithTrace(newTraceContext({ sampled: false }), () => {
    logger.debug("dropped debug");
    logger.info("dropped info");
    logger.error("kept error");
  });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const lines = shippedLines() as Array<{ msg?: string; level?: string; sampled?: boolean }>;
  expect(lines.map((l) => l.msg)).toEqual(["kept error"]);
  expect(lines[0]?.level).toBe("error");
  expect(lines[0]?.sampled).toBe(false);
});

it("ships everything from a sampled-in trace (no sampled flag emitted)", async () => {
  const logger = createLogger({
    service: "samp",
    component: "test",
    env: "test",
    level: "debug",
    kansoku: { url: "https://api.kansoku.localhost", token: "t", batchSize: 2 },
  });

  runWithTrace(newTraceContext({ sampled: true }), () => {
    logger.debug("kept debug");
    logger.info("kept info");
  });

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const lines = shippedLines() as Array<{ msg?: string; sampled?: boolean }>;
  expect(lines.map((l) => l.msg)).toEqual(["kept debug", "kept info"]);
  expect(lines.every((l) => l.sampled === undefined)).toBe(true);
});
