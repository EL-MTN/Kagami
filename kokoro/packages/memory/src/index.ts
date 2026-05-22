import { config, logger, tracedFetch } from "@kokoro/shared";
import { enqueuePendingFact } from "@kokoro/db";

// Typed fetch wrapper around Kioku's REST API. The only Kokoro module
// that knows Kioku exists — bot tools, schedulers, and context
// assembly should depend on this and not on the wire shape directly.
//
// Errors surface as KiokuClientError. Network/timeout errors are
// rethrown so callers can decide whether to fail open (e.g. searchMemory
// returning [] when Kioku is down) or fail loud.

export class KiokuClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "KiokuClientError";
  }
}

// Fast-path operations (recall, append, simple GETs) finish in <1s
// against a warm Kioku. Session ingest runs the LLM extraction pipeline
// over a transcript and is materially slower.
const FAST_TIMEOUT_MS = 10_000;
const INGEST_TIMEOUT_MS = 180_000;

export interface RecalledFact {
  id: string;
  text: string;
  event_date: string;
  source_session: string;
  created_at: string;
}

export interface RecallOptions {
  k?: number;
  since?: string;
  until?: string;
}

export interface AppendFactInput {
  text: string;
  event_date?: string;
  source_session?: string;
  user_id?: string;
}

export interface AppendFactResult {
  id: string;
  status: "added" | "duplicate";
  similarity?: number;
}

export interface QueuedAppendFactResult {
  status: "queued";
  queued: true;
  reason: string;
}

export interface FactDetail {
  id: string;
  text: string;
  text_lemmatized?: string;
  user_id: string;
  created_at: string;
  event_date: string;
  source_session: string;
  hash: string;
}

export interface IngestSessionInput {
  transcript: string;
}

export interface IngestSessionResult {
  sessionId: string;
  added: number;
  batches: number;
  failed: number; // batches that errored; a total failure (failed === batches) is a 500
}

function baseUrl(): string {
  return config.KIOKU_URL.replace(/\/+$/, "");
}

async function request<T>(
  method: "GET" | "POST",
  pathAndQuery: string,
  opts: { body?: unknown; timeoutMs: number },
): Promise<T> {
  const url = `${baseUrl()}${pathAndQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    // tracedFetch stamps the active W3C traceparent header so Kioku's trace
    // middleware can link this call into the same trace as the inbound
    // Telegram/iMessage update that triggered it.
    const res = await tracedFetch(url, {
      method,
      headers: opts.body ? { "content-type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }
      throw new KiokuClientError(
        `Kioku ${method} ${pathAndQuery} failed: ${res.status}`,
        res.status,
        body,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof KiokuClientError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new KiokuClientError(
        `Kioku ${method} ${pathAndQuery} timed out after ${opts.timeoutMs}ms`,
      );
    }
    logger.error({ error: err, url }, "kioku request transport error");
    throw new KiokuClientError(
      `Kioku ${method} ${pathAndQuery} transport error: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function recall(query: string, opts: RecallOptions = {}): Promise<RecalledFact[]> {
  const { facts } = await request<{ facts: RecalledFact[]; total: number }>("POST", "/recall", {
    body: { query, ...opts },
    timeoutMs: FAST_TIMEOUT_MS,
  });
  return facts;
}

export async function appendFact(input: AppendFactInput): Promise<AppendFactResult> {
  return request<AppendFactResult>("POST", "/facts", {
    body: input,
    timeoutMs: FAST_TIMEOUT_MS,
  });
}

function kiokuFailureReason(err: unknown): string {
  return err instanceof KiokuClientError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Kioku append failed";
}

export async function appendFactWithRetryQueue(
  input: AppendFactInput,
): Promise<AppendFactResult | QueuedAppendFactResult> {
  try {
    return await appendFact(input);
  } catch (err) {
    const reason = kiokuFailureReason(err);
    await enqueuePendingFact({
      text: input.text,
      eventDate: input.event_date,
      sourceSession: input.source_session ?? "appendFact",
      userId: input.user_id,
    });
    logger.warn({ error: err, sourceSession: input.source_session }, "queued pending Kioku fact");
    return { status: "queued", queued: true, reason };
  }
}

export async function getFactById(id: string): Promise<FactDetail | null> {
  try {
    return await request<FactDetail>("GET", `/facts/${encodeURIComponent(id)}`, {
      timeoutMs: FAST_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof KiokuClientError && err.status === 404) return null;
    throw err;
  }
}

// Probe whether Kioku already has at least one fact tagged with the given
// `source_session`. Used by the sweeper to avoid re-ingesting a session
// that already landed (which would create duplicate paraphrased facts if
// the extraction LLM produced different text on retry).
export async function hasFactsForSession(sourceSession: string): Promise<boolean> {
  const params = new URLSearchParams({ source_session: sourceSession, limit: "1" });
  const { total } = await request<{ total: number }>("GET", `/facts?${params.toString()}`, {
    timeoutMs: FAST_TIMEOUT_MS,
  });
  return total > 0;
}

export async function getFactCount(): Promise<number> {
  const { count } = await request<{ count: number }>("GET", "/facts/count", {
    timeoutMs: FAST_TIMEOUT_MS,
  });
  return count;
}

export async function ingestSession(input: IngestSessionInput): Promise<IngestSessionResult> {
  return request<IngestSessionResult>("POST", "/sessions", {
    body: input,
    timeoutMs: INGEST_TIMEOUT_MS,
  });
}

// Bot-shape glue: serialize Kokoro conversations and fire background ingest.
export { buildTranscript, transcriptHasContent } from "./transcript";
export { ingestClosedSession, ingestClosedSessionAwaited } from "./ingest";
export {
  nextPendingFactAttemptAt,
  sweepPendingIngests,
  sweepPendingFacts,
  sweepStaleActiveSessions,
  type SweepPendingFactsOptions,
  type SweepPendingFactsResult,
  type SweepPendingOptions,
  type SweepPendingResult,
  type SweepStaleActiveOptions,
  type SweepStaleActiveResult,
} from "./sweeper";
