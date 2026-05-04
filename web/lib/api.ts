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
} from './types';

const API_URL = process.env.KIZUNA_API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.KIZUNA_API_KEY ?? '';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function kz<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_KEY) {
    throw new ApiError(0, 'KIZUNA_API_KEY is not set in web/.env.local');
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status} ${path} — ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

const qs = (q?: Record<string, unknown>): string => {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const api = {
  listPeople: (q?: ListPeopleQuery) =>
    kz<ListResp<Person>>(`/v1/people${qs(q as Record<string, unknown> | undefined)}`),
  getPerson: (id: string) => kz<Person>(`/v1/people/${id}`),
  getPersonInteractions: (id: string, q?: ListInteractionsQuery) =>
    kz<ListResp<Interaction>>(
      `/v1/people/${id}/interactions${qs(q as Record<string, unknown> | undefined)}`,
    ),
  listInteractions: (q?: ListInteractionsQuery) =>
    kz<ListResp<Interaction>>(
      `/v1/interactions${qs(q as Record<string, unknown> | undefined)}`,
    ),
  listFollowups: (q?: ListFollowupsQuery) =>
    kz<ListResp<Followup>>(
      `/v1/followups${qs(q as Record<string, unknown> | undefined)}`,
    ),
  listOrganizations: (q?: ListOrganizationsQuery) =>
    kz<ListResp<Organization>>(
      `/v1/organizations${qs(q as Record<string, unknown> | undefined)}`,
    ),
  getOrganization: (id: string) => kz<Organization>(`/v1/organizations/${id}`),
  listContexts: (q?: ListContextsQuery) =>
    kz<{ items: ContextRow[] }>(
      `/v1/contexts${qs(q as Record<string, unknown> | undefined)}`,
    ),
  oauthStatus: () => kz<OAuthStatus>('/oauth/google/status'),
  gmailSyncState: () => kz<SyncState>('/v1/sync/gmail/state'),
  runGmailSync: (force?: boolean) =>
    kz<RunSyncResult>('/v1/sync/gmail/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { force: true } : {}),
    }),
  gcalSyncState: () => kz<SyncState>('/v1/sync/gcal/state'),
  runGcalSync: (force?: boolean) =>
    kz<RunCalendarSyncResult>('/v1/sync/gcal/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(force ? { force: true } : {}),
    }),
};

export function oauthStartUrl(): string {
  return `${API_URL}/oauth/google/start?key=${encodeURIComponent(API_KEY)}`;
}

export const config = {
  apiUrl: API_URL,
  apiKeyPresent: Boolean(API_KEY),
  userEmails: (process.env.USER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
};
