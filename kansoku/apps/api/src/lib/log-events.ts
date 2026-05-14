import { EventEmitter } from "node:events";
import type { StoredLog } from "../storage/logs.js";

// In-process broadcast: every ingested log is emitted on a single shared
// EventEmitter, and the last RING_SIZE logs are kept in a ring buffer so a
// fresh SSE subscriber can backfill recent context without round-tripping to
// Mongo. At Kagami's scale (10-100 logs/sec peak) keeping 500 entries in
// memory is ~50–100KB — trivial.
const RING_SIZE = 500;

const ring: StoredLog[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

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

export function subscribeLogs(listener: (doc: StoredLog) => void): () => void {
  emitter.on("log", listener);
  return () => emitter.off("log", listener);
}
