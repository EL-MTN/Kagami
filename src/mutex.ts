// Process-wide async mutex. Serializes vault-mutating operations
// (single-fact append, session ingest) so concurrent in-flight HTTP
// requests can't race on facts.jsonl / entities.jsonl appends.
//
// Reads don't need the lock — JSONL readers tolerate partial last
// lines (the line-split filter drops empty trailing lines), and a
// reader that races an appender just gets the pre-append snapshot.

let chain: Promise<unknown> = Promise.resolve();

export function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  // Swallow the error on the chain so a failed op doesn't poison
  // subsequent ones. The error still propagates to the caller via `next`.
  chain = next.catch(() => undefined);
  return next;
}
