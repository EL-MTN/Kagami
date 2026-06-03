import { Writable } from "node:stream";

export interface KansokuStreamOptions {
  /** Base URL of the Kansoku API, e.g. `https://api.kansoku.localhost`. */
  url: string;
  /** Shared HMAC token sent in `x-kansoku-auth`. */
  token: string;
  /** Max events per POST. Default 50. */
  batchSize?: number;
  /** Soft flush interval in ms. Default 250. */
  batchIntervalMs?: number;
  /** Hard upper bound on in-memory buffered events. Default 5000. */
  bufferLimit?: number;
  /**
   * Which end to discard when the buffer overflows. Default `"oldest"`
   * (recency-biased — what's happening *now* survives). `"newest"` rejects
   * fresh arrivals once full, preserving the *start* of an incident (the
   * root-cause lines), which is usually the more diagnostic half when a
   * burst overruns the buffer during a Kansoku outage.
   */
  dropPolicy?: "oldest" | "newest";
  /** Backoff ceiling in ms. Default 30_000. */
  maxBackoffMs?: number;
  /**
   * @internal — random source for backoff jitter, injectable so tests can
   * pin timing. Defaults to `Math.random`.
   */
  rng?: () => number;
  /**
   * Per-request timeout in ms. Default 10_000. A hung Kansoku connection
   * (TCP open, no response) is aborted after this so the in-flight guard
   * clears and the batch is requeued/backed-off like any other failure.
   * Without it a single stuck socket wedges the shipper forever and every
   * subsequent log line is silently dropped — fail-open turning fail-closed.
   */
  requestTimeoutMs?: number;
}

interface KansokuStreamInternals {
  /** @internal — exposed for tests + diagnostics. */
  bufferSize(): number;
  /** @internal — total events dropped due to overflow since process start. */
  droppedTotal(): number;
}

type KansokuStream = Writable & KansokuStreamInternals;

/**
 * Pino destination stream that batches NDJSON log lines and POSTs them to
 * Kansoku. Fail-open at every step: network errors (including a hung
 * connection, bounded by `requestTimeoutMs`) are swallowed and retried with
 * full-jitter exponential backoff (so a fleet of shippers reconnecting after
 * a Kansoku blip doesn't thunder onto the same retry tick); buffer overflow
 * drops per `dropPolicy` and surfaces the count in the next successful
 * request's `x-kansoku-dropped` header.
 *
 * Deliberately an in-process stream, not a pino worker-thread transport:
 * it must compose in the same `pino.multistream` as the console stream, and
 * the trace mixin reads AsyncLocalStorage synchronously at log-call time —
 * a worker boundary would sever both. The shipper does no CPU-bound work
 * (JSON join + `fetch`), so its event-loop cost is bounded; moving it to a
 * worker is a design change, not a hardening tweak, and is intentionally
 * out of scope.
 */
export function createKansokuStream(opts: KansokuStreamOptions): KansokuStream {
  const {
    url,
    token,
    batchSize = 50,
    batchIntervalMs = 250,
    bufferLimit = 5000,
    dropPolicy = "oldest",
    maxBackoffMs = 30_000,
    requestTimeoutMs = 10_000,
    rng = Math.random,
  } = opts;
  const ingestUrl = `${url.replace(/\/$/, "")}/v1/logs`;

  // Full jitter (AWS "Exponential Backoff and Jitter"): the doubling
  // `backoffMs` is the ceiling; the actual wait is uniform in [1, ceil].
  const jitteredDelay = (ceilMs: number): number => Math.max(1, Math.floor(rng() * ceilMs));

  let buffer: string[] = [];
  // `timer` is either the soft-flush timer (waiting batchIntervalMs after a
  // small write) or the backoff-retry timer (waiting backoffMs after a
  // failure) — never both. Sharing the slot keeps scheduleFlush's "is a
  // flush already on the way?" guard correct and prevents a 250 ms soft
  // flush from short-circuiting an in-flight exponential backoff.
  let timer: NodeJS.Timeout | null = null;
  // The active flush's promise (null when idle). `flush()` is idempotent
  // while one is running — concurrent callers receive the same promise so
  // `final()` can deterministically wait for it before the deadline fires.
  let inFlightPromise: Promise<void> | null = null;
  let droppedSinceLastSuccess = 0;
  let droppedTotal = 0;
  let backoffMs = batchIntervalMs;

  const scheduleFlush = (): void => {
    if (timer || inFlightPromise) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, batchIntervalMs);
    if (timer.unref) timer.unref();
  };

  const flush = (): Promise<void> => {
    if (inFlightPromise) return inFlightPromise;
    if (buffer.length === 0) return Promise.resolve();
    const p = doFlush();
    inFlightPromise = p.finally(() => {
      inFlightPromise = null;
      // If the catch path already armed a backoff retry, leave that timer
      // alone. Otherwise, if writes piled up while we were in flight,
      // schedule a fresh soft flush.
      if (!timer && buffer.length > 0) scheduleFlush();
    });
    return inFlightPromise;
  };

  const doFlush = async (): Promise<void> => {
    const batch = buffer;
    const dropCount = droppedSinceLastSuccess;
    buffer = [];
    droppedSinceLastSuccess = 0;
    try {
      const body = `[${batch.join(",")}]`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-kansoku-auth": token,
      };
      if (dropCount > 0) headers["x-kansoku-dropped"] = String(dropCount);
      // Abort a stalled request so this promise always settles. On abort
      // `fetch` rejects with an AbortError that falls through to the catch
      // below — same requeue + exponential-backoff path as any other
      // failure, so `inFlightPromise` clears and the shipper keeps draining.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();
      let res: Response;
      try {
        res = await fetch(ingestUrl, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error(`kansoku http ${res.status}`);
      backoffMs = batchIntervalMs;
    } catch {
      // Requeue at the front to preserve order; restore the previously
      // captured drop count (new overflow during the in-flight period has
      // already been added to `droppedSinceLastSuccess` by `write()`, so
      // we add — not overwrite — to preserve both).
      buffer = [...batch, ...buffer];
      droppedSinceLastSuccess += dropCount;
      if (buffer.length > bufferLimit) {
        const overflow = buffer.length - bufferLimit;
        // "newest" keeps the head (the requeued batch + oldest pending) and
        // drops the tail; "oldest" drops the front.
        buffer = dropPolicy === "newest" ? buffer.slice(0, bufferLimit) : buffer.slice(overflow);
        droppedSinceLastSuccess += overflow;
        droppedTotal += overflow;
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      // Park the retry in the shared `timer` slot so a concurrent
      // `scheduleFlush()` from `write()` won't race in a 250 ms flush.
      // Clear any prior pending timer first — sequential failures could
      // otherwise orphan an earlier retry handle (still `unref`'d so it
      // won't keep the process alive, but it would fire a redundant
      // `flush()` after `final()` already drained the stream).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, jitteredDelay(backoffMs));
      if (timer.unref) timer.unref();
    }
  };

  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        buffer.push(line);
        if (buffer.length > bufferLimit) {
          // "newest": drop the line we just pushed (reject the arrival,
          // keep the incident head). "oldest": drop the front.
          if (dropPolicy === "newest") buffer.pop();
          else buffer.shift();
          droppedSinceLastSuccess += 1;
          droppedTotal += 1;
        }
      }
      if (buffer.length >= batchSize) {
        void flush();
      } else {
        scheduleFlush();
      }
      cb();
    },
    final(cb) {
      // Best-effort drain on shutdown, capped so a hung POST can't block
      // shutdown forever. Wait for any in-flight flush, then attempt one
      // more if the buffer is non-empty — all under a single 5 s deadline.
      // `done` is the single-call gate; `cb` fires exactly once.
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        cb();
      };
      const deadline = setTimeout(finish, 5_000);
      if (deadline.unref) deadline.unref();
      void (async () => {
        try {
          if (inFlightPromise) await inFlightPromise;
          if (buffer.length > 0) await flush();
        } finally {
          clearTimeout(deadline);
          finish();
        }
      })();
    },
  }) as KansokuStream;

  stream.bufferSize = () => buffer.length;
  stream.droppedTotal = () => droppedTotal;

  return stream;
}
