import { EventEmitter } from "node:events";
import type { StoredLog } from "../storage/logs.js";

// In-process broadcast: every ingested log is emitted on a single shared
// EventEmitter, and the last RING_SIZE logs are kept in a ring buffer so a
// fresh SSE subscriber can backfill recent context without round-tripping to
// Mongo. At Kagami's scale (10-100 logs/sec peak) keeping 500 entries in
// memory is ~50–100KB — trivial.
const RING_SIZE = 500;

// Hard cap on concurrent SSE subscribers. Each browser tab opens one; the
// cap guards against runaway leaks from a misbehaving client or a load-test
// hammering /v1/tail. Sized well above realistic personal-use; rejected
// subscribers see a 503 instead of silently leaking listener refs.
const MAX_SUBSCRIBERS = 64;

const ring: StoredLog[] = [];
const emitter = new EventEmitter();
// Track our own count rather than leaning on EventEmitter's MaxListenersExceededWarning
// — we want a hard rejection at the route level, not a silent warning log.
emitter.setMaxListeners(MAX_SUBSCRIBERS + 4);
let subscriberCount = 0;

export function publishLog(doc: StoredLog): void {
  ring.push(doc);
  if (ring.length > RING_SIZE) ring.shift();
  emitter.emit("log", doc);
}

export function publishLogs(docs: StoredLog[]): void {
  for (const d of docs) publishLog(d);
}

export type LogFilter = (doc: StoredLog) => boolean;

export function recentLogs(filter: LogFilter = () => true, limit = 50): StoredLog[] {
  const matched: StoredLog[] = [];
  for (let i = ring.length - 1; i >= 0 && matched.length < limit; i--) {
    const doc = ring[i]!;
    if (filter(doc)) matched.push(doc);
  }
  return matched.reverse();
}

/**
 * Subscribe to log events. Returns an unsubscribe function, or `null` when
 * the subscriber cap is exhausted — caller should respond 503 instead of
 * silently dropping the connection.
 */
export function subscribeLogs(listener: (doc: StoredLog) => void): (() => void) | null {
  if (subscriberCount >= MAX_SUBSCRIBERS) return null;
  subscriberCount += 1;
  emitter.on("log", listener);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    emitter.off("log", listener);
  };
}

/** Diagnostics — used by /health-ish surfaces and tests. */
export function subscriberStats(): { count: number; max: number } {
  return { count: subscriberCount, max: MAX_SUBSCRIBERS };
}
