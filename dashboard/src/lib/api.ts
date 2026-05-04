const BASE = process.env.KIOKU_API_URL ?? "http://127.0.0.1:7777";

export interface Fact {
  id: string;
  text: string;
  text_lemmatized?: string;
  user_id: string;
  run_id?: string;
  agent_id?: string;
  created_at: string;
  event_date: string;
  source_session: string;
  hash: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface RankedFact extends Fact {
  score?: number;
  semantic?: number;
  bm25?: number;
  entity_boost?: number;
}

export interface FactsListResponse {
  total: number;
  limit: number;
  offset: number;
  facts: Fact[];
}

export interface RecallResponse {
  facts: RankedFact[];
  total: number;
}

export interface QueryResponse {
  answer: string;
  citations?: string[];
  /** Optional — populated only if the backend has been extended to return supporting facts. */
  facts?: RankedFact[];
}

export interface HistoryEvent {
  memory_id: string;
  event: "ADD" | "UPDATE" | "DELETE";
  new_text?: string;
  old_text?: string;
  actor?: string;
  created_at: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`kioku ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<{ ok: boolean }> {
  return api("/health");
}

export async function getVersion(): Promise<{ name: string; version: string }> {
  return api("/version");
}

export async function getFactCount(): Promise<{ count: number }> {
  return api("/facts/count");
}

export async function listFacts(params: {
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  source_session?: string;
  user_id?: string;
  run_id?: string;
  agent_id?: string;
} = {}): Promise<FactsListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return api(`/facts${suffix}`);
}

export async function getFact(id: string): Promise<Fact | null> {
  try {
    return await api<Fact>(`/facts/${id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return null;
    throw err;
  }
}

export async function getFactHistory(id: string): Promise<{ id: string; events: HistoryEvent[] }> {
  return api(`/facts/${id}/history`);
}

export async function recall(body: {
  query: string;
  k?: number;
}): Promise<RecallResponse> {
  return api("/recall", { method: "POST", body: JSON.stringify(body) });
}

export async function query(body: {
  question: string;
  k?: number;
}): Promise<QueryResponse> {
  return api("/query", { method: "POST", body: JSON.stringify(body) });
}

export const KIOKU_BASE = BASE;
