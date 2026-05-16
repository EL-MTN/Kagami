import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKansokuStream } from "../src/kansoku-stream";

// kansoku-stream drives all of its timing through setTimeout (soft flush,
// exponential backoff, the request-abort deadline) and a single global
// `fetch`. Fake timers + a hand-driven fetch mock let us assert the
// batch / requeue / backoff / overflow / drain / timeout behavior
// deterministically without real sockets or sleeps.
//
// The shipper concatenates buffered lines verbatim into a JSON array
// (`[line,line]`), so every test line must itself be a valid JSON object —
// exactly the NDJSON pino emits.

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};
type FetchMock = ReturnType<typeof vi.fn<(url: string, init: FetchInit) => Promise<Response>>>;

const URL_BASE = "https://api.kansoku.localhost";
const TOKEN = "test-token";

let originalFetch: typeof globalThis.fetch;
let fetchMock: FetchMock;

/** A pino-shaped NDJSON line for id `n`, newline-terminated like pino writes. */
function line(n: string | number): string {
  return `${JSON.stringify({ n })}\n`;
}

function ok(): Response {
  return new Response(null, { status: 202 });
}

/** JSON-decode the NDJSON-array body of the Nth fetch call. */
function bodyOf(call: number): unknown {
  const init = fetchMock.mock.calls[call][1];
  return JSON.parse(init.body);
}

function headersOf(call: number): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers;
}

beforeEach(() => {
  vi.useFakeTimers();
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("batching", () => {
  it("flushes immediately once batchSize lines are buffered", async () => {
    fetchMock.mockResolvedValue(ok());
    const s = createKansokuStream({ url: URL_BASE, token: TOKEN, batchSize: 3 });

    s.write(line("a"));
    s.write(line("b"));
    expect(fetchMock).not.toHaveBeenCalled();
    s.write(line("c"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${URL_BASE}/v1/logs`);
    expect(headersOf(0)["x-kansoku-auth"]).toBe(TOKEN);
    expect(bodyOf(0)).toEqual([{ n: "a" }, { n: "b" }, { n: "c" }]);
    expect(s.bufferSize()).toBe(0);
  });

  it("soft-flushes a partial batch after batchIntervalMs", async () => {
    fetchMock.mockResolvedValue(ok());
    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 50,
      batchIntervalMs: 250,
    });

    s.write(line("only"));
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).toEqual([{ n: "only" }]);
  });
});

describe("requeue + backoff", () => {
  it("requeues the batch in order and retries after escalating backoff", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down")).mockResolvedValue(ok());
    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 2,
      batchIntervalMs: 100,
    });

    s.write(line("a"));
    s.write(line("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Backoff after the first failure is batchIntervalMs * 2 = 200ms.
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Order preserved across the requeue.
    expect(bodyOf(1)).toEqual([{ n: "a" }, { n: "b" }]);
    expect(s.bufferSize()).toBe(0);
  });

  it("treats a non-2xx response as a failure and requeues", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(ok());
    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 1,
      batchIntervalMs: 100,
    });

    s.write(line("x"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual([{ n: "x" }]);
  });
});

describe("overflow accounting", () => {
  it("drops oldest past bufferLimit and reports the count via x-kansoku-dropped", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 100,
      batchIntervalMs: 50,
      bufferLimit: 3,
      maxBackoffMs: 50,
    });

    for (const c of [1, 2, 3, 4, 5]) s.write(line(c));
    // bufferLimit 3 → 1,2 dropped in write() before any flush.
    expect(s.droppedTotal()).toBe(2);
    expect(s.bufferSize()).toBe(3);

    // Let one failing flush cycle run, then let the next attempt succeed.
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockResolvedValue(ok());
    await vi.advanceTimersByTimeAsync(50);

    const successCall = fetchMock.mock.calls.length - 1;
    expect(headersOf(successCall)["x-kansoku-dropped"]).toBe("2");
    expect(bodyOf(successCall)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(s.droppedTotal()).toBe(2);
  });
});

describe("final() drain", () => {
  it("waits for an in-flight flush then resolves", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(ok());
        }),
    );
    const s = createKansokuStream({ url: URL_BASE, token: TOKEN, batchSize: 1 });

    s.write(line("x"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let finished = false;
    const ended = new Promise<void>((resolve) =>
      s.end(() => {
        finished = true;
        resolve();
      }),
    );

    // Drain is parked on the in-flight fetch — not done yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);

    release!();
    await vi.advanceTimersByTimeAsync(0);
    await ended;
    expect(finished).toBe(true);
    expect(s.bufferSize()).toBe(0);
  });

  it("gives up after the 5s deadline if the request never settles", async () => {
    // A request that ignores the abort signal entirely (worst case).
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 1,
      requestTimeoutMs: 60_000,
    });

    s.write(line("stuck"));
    await vi.advanceTimersByTimeAsync(0);

    let finished = false;
    const ended = new Promise<void>((resolve) =>
      s.end(() => {
        finished = true;
        resolve();
      }),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(finished).toBe(true);
  });
});

describe("request timeout (Tier-1 wedge regression)", () => {
  it("aborts a hung request and recovers instead of dropping all subsequent logs", async () => {
    let calls = 0;
    fetchMock.mockImplementation((_url, init) => {
      calls += 1;
      if (calls === 1) {
        // Hangs until aborted — the exact failure that, pre-fix, left
        // inFlightPromise permanently set and silently dropped everything.
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return Promise.resolve(ok());
    });

    const s = createKansokuStream({
      url: URL_BASE,
      token: TOKEN,
      batchSize: 1,
      batchIntervalMs: 100,
      requestTimeoutMs: 1_000,
      maxBackoffMs: 1_000,
    });

    s.write(line("a")); // flush #1 — hangs
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    s.write(line("b")); // pre-fix: wedged behind the stuck in-flight promise forever

    // requestTimeoutMs fires → abort → reject → catch → requeue + backoff.
    await vi.advanceTimersByTimeAsync(1_000);
    // Backoff after the failure is min(100*2, 1000) = 200ms.
    await vi.advanceTimersByTimeAsync(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual([{ n: "a" }, { n: "b" }]);
    expect(s.bufferSize()).toBe(0);
  });
});
