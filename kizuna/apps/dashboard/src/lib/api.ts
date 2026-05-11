import type {
  ContextRow,
  Followup,
  Interaction,
  ListContextsQuery,
  ListFollowupsQuery,
  ListInteractionsQuery,
  ListOrganizationsQuery,
  ListPeopleQuery,
  ListResp,
  OAuthStatus,
  Organization,
  Person,
  RunCalendarSyncResult,
  RunSyncResult,
  SyncState,
} from "./types";

const API_URL = process.env.KIZUNA_API_URL ?? "https://api.kizuna.localhost";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function kz<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, `${res.status} ${path} — ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

const qs = (q?: Record<string, unknown>): string => {
  if (!q) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
          sp.append(k, String(x));
        }
      }
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const api = {
  listPeople: (q?: ListPeopleQuery) => kz<ListResp<Person>>(`/people${qs(q)}`),
  getPerson: (id: string) => kz<Person>(`/people/${id}`),
  getPersonInteractions: (id: string, q?: ListInteractionsQuery) =>
    kz<ListResp<Interaction>>(`/people/${id}/interactions${qs(q)}`),
  listInteractions: (q?: ListInteractionsQuery) =>
    kz<ListResp<Interaction>>(`/interactions${qs(q)}`),
  listFollowups: (q?: ListFollowupsQuery) => kz<ListResp<Followup>>(`/followups${qs(q)}`),
  listOrganizations: (q?: ListOrganizationsQuery) =>
    kz<ListResp<Organization>>(`/organizations${qs(q)}`),
  getOrganization: (id: string) => kz<Organization>(`/organizations/${id}`),
  listContexts: (q?: ListContextsQuery) => kz<{ items: ContextRow[] }>(`/contexts${qs(q)}`),
  oauthStatus: () => kz<OAuthStatus>("/oauth/google/status"),
  gmailSyncState: () => kz<SyncState>("/sync/gmail/state"),
  runGmailSync: (force?: boolean) =>
    kz<RunSyncResult>("/sync/gmail/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
    }),
  gcalSyncState: () => kz<SyncState>("/sync/gcal/state"),
  runGcalSync: (force?: boolean) =>
    kz<RunCalendarSyncResult>("/sync/gcal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
    }),
};

export function oauthStartUrl(): string {
  return `${API_URL}/oauth/google/start`;
}

export const config = {
  apiUrl: API_URL,
  userEmails: (process.env.USER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};
