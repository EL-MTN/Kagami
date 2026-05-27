/**
 * Polling helpers for async-write tests.
 *
 * Fire-and-forget code paths (`void notify(...)`, `void recordX(...)`)
 * resolve before their side effects land — assertions polled with a
 * "length >= min" check return too early and let late arrivals leak
 * into the next test. `quiesce` waits for the source to be stable
 * (`min` items present AND no change for `quietMs`) before resolving.
 *
 * Callers pass a `length: () => number` source so the same helper works
 * for an in-memory captured array, a Mongo collection count, etc.
 */

export interface QuiesceOptions {
  /** Function returning the current size of the source being watched. */
  length: () => number;
  /** Minimum size required. Pass 0 to wait for the source to stop changing. */
  min?: number;
  /** Overall deadline. */
  timeoutMs?: number;
  /** Require this many ms of no-change before resolving. */
  quietMs?: number;
  /** When true (default), throw on timeout. When false, return silently. */
  throwOnTimeout?: boolean;
  /** Human-readable name for the timeout message. */
  label?: string;
}

export async function quiesce(opts: QuiesceOptions): Promise<void> {
  const {
    length,
    min = 0,
    timeoutMs = 3_000,
    quietMs = 100,
    throwOnTimeout = true,
    label = "source",
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastLength = length();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const current = length();
    if (current !== lastLength) {
      lastLength = current;
      lastChange = Date.now();
    }
    if (current >= min && Date.now() - lastChange >= quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (throwOnTimeout) {
    throw new Error(`${label}: expected at least ${min} within ${timeoutMs}ms; got ${lastLength}`);
  }
}
