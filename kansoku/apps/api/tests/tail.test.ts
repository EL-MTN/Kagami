import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, expect, it } from "vitest";
import { publishLog } from "../src/lib/log-events.ts";
import { tailRouter } from "../src/routes/tail.ts";
import type { StoredLog } from "../src/storage/logs.ts";

// SSE tests bypass Mongo entirely — the broadcaster is in-process, so we can
// exercise the tail endpoint without spinning up a memory server.

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/v1", tailRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function makeLog(overrides: Partial<StoredLog> = {}): StoredLog {
  return {
    ts: new Date(),
    meta: { service: "kioku-api", component: "api", env: "test", level: "info" },
    msg: "hello",
    ...overrides,
  };
}

// Read SSE `data:` lines off a fetch response until `expected` events have
// arrived or the timeout fires. Returns the parsed payloads in arrival order.
async function readEvents(
  res: Response,
  expected: number,
  timeoutMs = 3_000,
): Promise<StoredLog[]> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: StoredLog[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (out.length < expected) {
    if (Date.now() > deadline) {
      throw new Error(`SSE only received ${out.length}/${expected} events before timeout`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          out.push(JSON.parse(line.slice(6)) as StoredLog);
        }
      }
    }
  }
  await reader.cancel();
  return out;
}

it("streams newly published logs over SSE", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/v1/tail?replay=0`, { signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

  // Give the subscriber a tick to register before we publish.
  await new Promise((r) => setTimeout(r, 50));
  publishLog(makeLog({ msg: "first" }));
  publishLog(makeLog({ msg: "second" }));

  try {
    const events = await readEvents(res, 2);
    expect(events.map((e) => e.msg)).toEqual(["first", "second"]);
  } finally {
    ctrl.abort();
  }
});

it("filters by service and level", async () => {
  publishLog(
    makeLog({
      msg: "for-replay",
      meta: { service: "kioku-api", component: "api", env: "test", level: "warn" },
    }),
  );

  const ctrl = new AbortController();
  const res = await fetch(`${baseUrl}/v1/tail?service=kioku-api&level=warn,error&replay=20`, {
    signal: ctrl.signal,
  });

  await new Promise((r) => setTimeout(r, 50));
  publishLog(
    makeLog({
      msg: "filtered-out-by-level",
      meta: { service: "kioku-api", component: "api", env: "test", level: "info" },
    }),
  );
  publishLog(
    makeLog({
      msg: "filtered-out-by-service",
      meta: { service: "other", component: "x", env: "test", level: "error" },
    }),
  );
  publishLog(
    makeLog({
      msg: "should-arrive",
      meta: { service: "kioku-api", component: "api", env: "test", level: "error" },
    }),
  );

  try {
    const events = await readEvents(res, 2); // for-replay (warn) + should-arrive (error)
    const msgs = events.map((e) => e.msg);
    expect(msgs).toContain("should-arrive");
    expect(msgs).not.toContain("filtered-out-by-level");
    expect(msgs).not.toContain("filtered-out-by-service");
  } finally {
    ctrl.abort();
  }
});

it("rejects malformed replay query with 400", async () => {
  const res = await fetch(`${baseUrl}/v1/tail?replay=notanumber`);
  expect(res.status).toBe(400);
});
