/**
 * Map `items` through `fn` with at most `limit` calls in flight at once,
 * preserving input order in the returned array. A worker pool of
 * `min(limit, items.length)` pulls from a shared cursor, so a slow item never
 * blocks others beyond the concurrency budget.
 *
 * `fn` is expected to settle for every item (catch its own errors if partial
 * results are desired); a rejection propagates and rejects the whole call.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return results;
}
