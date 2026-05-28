// Resolved server-side and threaded to client components via prop
// (`TailClient`, etc). Browser EventSource calls hit this directly, so the
// URL must be reachable from the user's browser, not just from the
// dashboard's Next.js server runtime. The default Portless host satisfies
// both; override only when both sides see the same hostname.
const BASE = process.env.KANSOKU_API_URL ?? "https://api.kansoku.localhost";

// Boundary type swap: the server keeps `ts` as a JS `Date`, but JSON
// serialization stringifies it. Anything calling `new Date(log.ts)` on the
// dashboard works as expected; don't accidentally re-type this as `Date`
// without also adding a `JSON.parse` reviver.
export interface StoredLog {
  ts: string;
  meta: {
    service: string;
    component: string;
    env: string;
    level: string;
  };
  msg?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  fields?: Record<string, unknown>;
}

interface LogsResponse {
  logs: StoredLog[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`kansoku ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<{ ok: boolean }> {
  return api("/health");
}

export async function getVersion(): Promise<{ name: string; version: string }> {
  return api("/version");
}

interface SearchLogsParams {
  service?: string;
  level?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export async function searchLogs(params: SearchLogsParams = {}): Promise<LogsResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return api(`/v1/logs${suffix}`);
}

export interface StoredSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
  component: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
}

interface TraceResponse {
  traceId: string;
  logs: StoredLog[];
  // Real spans (build-light tracing). Empty for traces logged before spans
  // existed — the page falls back to a log-derived waterfall then.
  spans?: StoredSpan[];
}

export async function getTrace(id: string): Promise<TraceResponse> {
  return api(`/v1/traces/${encodeURIComponent(id)}`);
}

export interface ErrorRecord {
  _id: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  sampleMsg?: string;
  sampleStack?: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  recentTraceIds: string[];
}

interface ErrorsResponse {
  errors: ErrorRecord[];
}

export async function listErrors(
  params: { service?: string; limit?: number } = {},
): Promise<ErrorsResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return api(`/v1/errors${suffix}`);
}

export interface ServiceSummary {
  service: string;
  count: number;
  errorCount: number;
  warnCount: number;
  lastSeen: string | null;
  components: string[];
}

interface ServiceSummaryResponse {
  since: string;
  services: ServiceSummary[];
}

export async function listServices(
  params: { windowHours?: number } = {},
): Promise<ServiceSummaryResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return api(`/v1/services${suffix}`);
}

export interface ServiceTimelineBucket {
  ts: string;
  count: number;
  errorCount: number;
}

interface ServiceTimelineResponse {
  service: string;
  since: string;
  granularity: "minute" | "hour" | "day";
  buckets: ServiceTimelineBucket[];
}

// In-memory TTL cache for per-service timelines. The /services page fans out
// one fetch per service on every render — without this, every visit fires N
// aggregations against Mongo. 30 s is short enough that the sparklines feel
// fresh and long enough to absorb back-to-back refreshes.
const TIMELINE_CACHE_TTL_MS = 30_000;
const timelineCache = new Map<string, { ts: number; data: ServiceTimelineResponse }>();

export async function getServiceTimeline(
  service: string,
  params: { windowHours?: number; granularity?: "minute" | "hour" | "day" } = {},
): Promise<ServiceTimelineResponse> {
  const cacheKey = `${service}|${params.windowHours ?? "auto"}|${params.granularity ?? "auto"}`;
  const hit = timelineCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.ts < TIMELINE_CACHE_TTL_MS) return hit.data;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  const data = await api<ServiceTimelineResponse>(
    `/v1/services/${encodeURIComponent(service)}/timeline${suffix}`,
  );
  timelineCache.set(cacheKey, { ts: now, data });
  // Cheap eviction: drop TTL-expired entries first, then if the cache is
  // still over the bound, drop the oldest by insertion. Without the
  // oldest-drop fallback the Map could grow unbounded when the realistic
  // working set (services × windows × granularities ≈ 120) outstrips the
  // TTL window and every entry is fresh.
  if (timelineCache.size > 64) {
    for (const [k, v] of timelineCache) {
      if (now - v.ts >= TIMELINE_CACHE_TTL_MS) timelineCache.delete(k);
    }
    while (timelineCache.size > 64) {
      const oldestKey = timelineCache.keys().next().value;
      if (oldestKey === undefined) break;
      timelineCache.delete(oldestKey);
    }
  }
  return data;
}

export const KANSOKU_BASE = BASE;
