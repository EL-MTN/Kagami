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

export function makeCalendarClient(getAccessToken: () => Promise<string>): CalendarClient {
  return {
    async listEvents(params) {
      const token = await getAccessToken();
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
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CalendarHttpError(res.status, body);
      }
      return (await res.json()) as ListEventsResp;
    },
  };
}
