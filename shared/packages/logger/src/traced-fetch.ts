import { formatTraceparent, getTraceContext } from "./trace.js";

/**
 * Drop-in replacement for `globalThis.fetch` that propagates the active
 * trace context as a W3C `traceparent` header. When there's no active
 * context, behaves identically to plain `fetch`.
 *
 * The current span's spanId is sent on the wire — the receiving server
 * treats it as the parent for the child span it opens on receipt. We
 * deliberately do NOT mint a new client-side span here; in Kagami's
 * personal-scale setup the client and server work for a single request
 * live on the same span tree without an explicit "RPC client" span.
 */
export async function tracedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const ctx = getTraceContext();
  if (!ctx) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set("traceparent", formatTraceparent(ctx));
  return fetch(input, { ...init, headers });
}
