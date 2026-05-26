import type { CalendarEvent } from "./parse-event.js";
import {
  GOOGLE_REQUEST_TIMEOUT_MS,
  GoogleRequestTimeoutError,
  isAbortSignalTimeout,
} from "./google-timeout.js";

const BASE = "https://www.googleapis.com/calendar/v3";

export type ListEventsParams = {
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  maxResults?: number;
};

export type ListEventsResp = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type CalendarClient = {
  listEvents(params: ListEventsParams): Promise<ListEventsResp>;
};

export class CalendarHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`calendar api ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class SyncTokenExpired extends Error {
  constructor() {
    super("calendar syncToken expired (410 Gone)");
  }
}

// See gmail-client.ts for the full rationale on `{ force }` and the
// 401/403 self-heal retry — same shape, same Kao-cache-bypass semantics.
export type AccessTokenGetter = (options?: { force?: boolean }) => Promise<string>;

export function makeCalendarClient(getAccessToken: AccessTokenGetter): CalendarClient {
  async function listEventsOnce(params: ListEventsParams, force: boolean): Promise<ListEventsResp> {
    const token = await getAccessToken({ force });
    const sp = new URLSearchParams();
    sp.set("singleEvents", "true");
    sp.set("showDeleted", "true");
    sp.set("maxResults", String(params.maxResults ?? 250));
    if (params.syncToken) {
      sp.set("syncToken", params.syncToken);
    } else {
      if (params.timeMin) sp.set("timeMin", params.timeMin);
      sp.set("orderBy", "startTime");
    }
    if (params.pageToken) sp.set("pageToken", params.pageToken);
    const url = `${BASE}/calendars/primary/events?${sp.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (isAbortSignalTimeout(err)) throw new GoogleRequestTimeoutError("gcal");
      throw err;
    }
    if (res.status === 410) throw new SyncTokenExpired();
    if ((res.status === 401 || res.status === 403) && !force) {
      // Google rejected the cached access token (401) or said it has the
      // wrong scopes (403) — force-refresh via Kao and retry exactly once.
      // See gmail-client.ts for the full rationale.
      return listEventsOnce(params, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CalendarHttpError(res.status, body);
    }
    return (await res.json()) as ListEventsResp;
  }

  return {
    listEvents: (params) => listEventsOnce(params, false),
  };
}
