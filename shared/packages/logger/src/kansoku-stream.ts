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
  /** Hard upper bound on in-memory buffered events; oldest are dropped on overflow. Default 5000. */
  bufferLimit?: number;
  /** Backoff ceiling in ms. Default 30_000. */
  maxBackoffMs?: number;
}

interface KansokuStreamInternals {
  /** @internal — exposed for tests + diagnostics. */
  bufferSize(): number;
  /** @internal — total events dropped due to overflow since process start. */
  droppedTotal(): number;
}

export type KansokuStream = Writable & KansokuStreamInternals;

/**
 * Pino destination stream that batches NDJSON log lines and POSTs them to
 * Kansoku. Fail-open at every step: network errors are swallowed and retried
 * with exponential backoff; buffer overflow drops oldest events and surfaces
 * the count in the next successful request's `x-kansoku-dropped` header.
 */
export function createKansokuStream(opts: KansokuStreamOptions): KansokuStream {
  const {
    url,
    token,
    batchSize = 50,
    batchIntervalMs = 250,
    bufferLimit = 5000,
    maxBackoffMs = 30_000,
  } = opts;
  const ingestUrl = `${url.replace(/\/$/, "")}/v1/logs`;

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
      const res = await fetch(ingestUrl, { method: "POST", headers, body });
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
        buffer = buffer.slice(overflow);
        droppedSinceLastSuccess += overflow;
        droppedTotal += overflow;
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      // Park the retry in the shared `timer` slot so a concurrent
      // `scheduleFlush()` from `write()` won't race in a 250 ms flush.
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, backoffMs);
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
          buffer.shift();
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
