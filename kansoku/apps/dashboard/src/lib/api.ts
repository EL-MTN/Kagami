const BASE = process.env.KANSOKU_API_URL ?? "https://api.kansoku.localhost";

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

export interface LogsResponse {
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

export interface SearchLogsParams {
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

export interface TraceResponse {
  traceId: string;
  logs: StoredLog[];
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

export interface ErrorsResponse {
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

export const KANSOKU_BASE = BASE;
