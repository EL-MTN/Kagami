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
  bufferSize(): number;
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
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let droppedSinceLastSuccess = 0;
  let droppedTotal = 0;
  let backoffMs = batchIntervalMs;

  const scheduleFlush = (): void => {
    if (timer || inFlight) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, batchIntervalMs);
    if (timer.unref) timer.unref();
  };

  const flush = async (): Promise<void> => {
    if (inFlight || buffer.length === 0) return;
    inFlight = true;
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
      // Requeue at the front to preserve order; trim to bufferLimit.
      buffer = [...batch, ...buffer];
      droppedSinceLastSuccess += dropCount;
      if (buffer.length > bufferLimit) {
        const overflow = buffer.length - bufferLimit;
        buffer = buffer.slice(overflow);
        droppedSinceLastSuccess += overflow;
        droppedTotal += overflow;
      }
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      const retry = setTimeout(() => void flush(), backoffMs);
      if (retry.unref) retry.unref();
    } finally {
      inFlight = false;
      if (buffer.length > 0 && !timer) scheduleFlush();
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
      // Best-effort drain on shutdown, capped so it can't block forever.
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        cb();
      };
      const deadline = setTimeout(finish, 5_000);
      if (deadline.unref) deadline.unref();
      void (async () => {
        try {
          await flush();
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
