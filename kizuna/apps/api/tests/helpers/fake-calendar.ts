import {
  CalendarHttpError,
  SyncTokenExpired,
  type CalendarClient,
  type ListEventsParams,
  type ListEventsResp,
} from "../../src/ingest/calendar-client.js";
import type { CalendarEvent } from "../../src/ingest/parse-event.js";
import { GoogleRequestTimeoutError } from "../../src/ingest/google-timeout.js";

export class FakeCalendarClient implements CalendarClient {
  // Each call to listEvents shifts the next "snapshot" off this queue, allowing
  // a test to script a sequence of bootstrap → incremental → ... runs.
  responseQueue: ListEventsResp[] = [];

  // If non-empty, the next call throws this error before the queue is checked.
  throwNext: Error[] = [];

  // Last params seen — useful for assertions.
  lastParams: ListEventsParams | null = null;

  enqueueBootstrap(events: CalendarEvent[], nextSyncToken = "sync-1"): void {
    this.responseQueue.push({ items: events, nextSyncToken });
  }

  enqueueIncremental(events: CalendarEvent[], nextSyncToken: string): void {
    this.responseQueue.push({ items: events, nextSyncToken });
  }

  throwSyncTokenExpiredOnce(): void {
    this.throwNext.push(new SyncTokenExpired());
  }

  throw401Once(): void {
    this.throwNext.push(new CalendarHttpError(401, '{"error":"invalid_grant"}'));
  }

  throwTimeoutOnce(): void {
    this.throwNext.push(new GoogleRequestTimeoutError("gcal"));
  }

  async listEvents(params: ListEventsParams): Promise<ListEventsResp> {
    this.lastParams = params;
    if (this.throwNext.length > 0) {
      const e = this.throwNext.shift()!;
      throw e;
    }
    if (this.responseQueue.length === 0) {
      return { items: [] };
    }
    return this.responseQueue.shift()!;
  }
}
