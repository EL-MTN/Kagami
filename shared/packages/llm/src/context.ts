import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-call op label seam. Callers wrap the AI SDK generate/object/embed promise
 * with `withCallOp("answer", () => generateText({...}))`; the label is held in
 * AsyncLocalStorage for the duration of that promise. The fallback composite's
 * span emitter runs inside the same async context, so `getActiveCallOp()`
 * recovers the label and attaches it to the usage span — labelling spans by the
 * caller's intent without threading the op through every model call.
 */
const callOpStore = new AsyncLocalStorage<string>();

/** Run `fn` with `op` recorded as the active call op for its async context. */
export function withCallOp<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return callOpStore.run(op, fn);
}

/** The op label active in the current async context, if any. */
export function getActiveCallOp(): string | undefined {
  return callOpStore.getStore();
}
