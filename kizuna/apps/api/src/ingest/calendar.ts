import type { Config } from "../config.js";
import { SyncState } from "../db/models/SyncState.js";
import {
  upsertInteractionBySourceRef,
  type RecordInteractionInput,
} from "../db/recordInteraction.js";
import { OAuthError } from "../lib/google-auth.js";
import { logger } from "../lib/logger.js";
import { CalendarHttpError, SyncTokenExpired, type CalendarClient } from "./calendar-client.js";
import { GoogleRequestTimeoutError } from "./google-timeout.js";
import {
  parseCalendarEvent,
  type CalendarEvent,
  type ParsedAttendee,
  type ParsedEvent,
} from "./parse-event.js";
import { upsertPerson } from "./upsert-person.js";

export type CalendarSyncResult = {
  status: "ok" | "paused" | "no_grant" | "error";
  fetched: number;
  upserted: number;
  cancelled: number;
  errors: number;
  syncTokenAfter: string | null;
  resyncedFromBootstrap: boolean;
  message?: string;
};

const PAGE_SIZE = 250;

async function loadOrInitState() {
  const existing = await SyncState.findOne({ provider: "gcal" });
  if (existing) return existing;
  return await SyncState.create({
    provider: "gcal",
    syncToken: null,
    historyId: null,
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    pausedAt: null,
    source: "gcal-sync",
  });
}

async function pauseWith(message: string): Promise<void> {
  await SyncState.updateOne(
    { provider: "gcal" },
    {
      $set: {
        pausedAt: new Date(),
        lastError: message,
        lastRunAt: new Date(),
      },
      $inc: { errorCount: 1 },
    },
  );
}

async function recordRun(syncTokenAfter: string | null): Promise<void> {
  const update: Record<string, unknown> = {
    lastRunAt: new Date(),
    lastError: null,
  };
  if (syncTokenAfter !== null) update.syncToken = syncTokenAfter;
  await SyncState.updateOne({ provider: "gcal" }, { $set: update });
}

async function recordFailedRun(message: string): Promise<void> {
  await SyncState.updateOne(
    { provider: "gcal" },
    {
      $set: { lastError: message, lastRunAt: new Date() },
      $inc: { errorCount: 1 },
    },
  );
}

async function clearSyncToken(): Promise<void> {
  await SyncState.updateOne({ provider: "gcal" }, { $set: { syncToken: null } });
}

async function listAll(
  client: CalendarClient,
  initial: { syncToken?: string; timeMin?: string },
): Promise<{ events: CalendarEvent[]; nextSyncToken: string | null }> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  while (true) {
    const page = await client.listEvents({
      ...initial,
      maxResults: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    if (page.items) events.push(...page.items);
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { events, nextSyncToken };
}

async function processEvent(
  ev: CalendarEvent,
  config: Config,
  result: CalendarSyncResult,
): Promise<void> {
  let parsed: ParsedEvent;
  try {
    parsed = parseCalendarEvent(ev);
  } catch (err) {
    result.errors++;
    logger.warn({ err, id: ev.id }, "gcal: failed to parse event");
    return;
  }

  // Resolve participants. Organizer first (role 'from'), then attendees.
  const participants: RecordInteractionInput["participants"] = [];
  const seen = new Set<string>();

  const link = async (a: ParsedAttendee, role: "from" | "attendee"): Promise<void> => {
    if (seen.has(a.email)) return;
    seen.add(a.email);
    try {
      const r = await upsertPerson({
        email: a.email,
        displayName: a.displayName ?? "",
        occurredAt: parsed.occurredAt,
        source: "gcal-sync",
      });
      participants.push({ personId: r.personId, role });
    } catch (err) {
      result.errors++;
      logger.warn({ err, email: a.email, eventId: ev.id }, "gcal: upsertPerson failed");
    }
  };

  // Skip-self on group events: drop USER_EMAILS attendees when ≥ 2 others
  // remain. Organizer (role 'from') is preserved either way so outbound
  // detection still works for events the user organized.
  const userSet = new Set(config.USER_EMAILS);
  const others = parsed.attendees.filter((a) => !userSet.has(a.email));
  const attendees = others.length >= 2 ? others : parsed.attendees;

  if (parsed.organizer) await link(parsed.organizer, "from");
  for (const a of attendees) await link(a, "attendee");

  if (participants.length === 0) {
    // No resolvable attendees — skip rather than violate the schema invariant.
    if (parsed.cancelled) result.cancelled++;
    return;
  }

  try {
    await upsertInteractionBySourceRef({
      occurredAt: parsed.occurredAt,
      channel: "calendar",
      title: parsed.title,
      body: parsed.body,
      participants,
      ...(parsed.location ? { location: parsed.location } : {}),
      sourceRef: { provider: "gcal", id: parsed.id },
      source: "gcal-sync",
      status: parsed.cancelled ? "cancelled" : "active",
    });
    result.upserted++;
    if (parsed.cancelled) result.cancelled++;
  } catch (err) {
    result.errors++;
    logger.warn({ err, id: ev.id }, "gcal: upsertInteractionBySourceRef failed");
  }
  // Suppress unused-config warning — kept for symmetry with gmail worker.
  void config;
}

async function bootstrap(
  client: CalendarClient,
  config: Config,
  result: CalendarSyncResult,
): Promise<string | null> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - config.KIZUNA_GCAL_BACKFILL_DAYS);
  const { events, nextSyncToken } = await listAll(client, {
    timeMin: since.toISOString(),
  });
  for (const ev of events) {
    result.fetched++;
    await processEvent(ev, config, result);
  }
  return nextSyncToken;
}

async function incremental(
  syncToken: string,
  client: CalendarClient,
  config: Config,
  result: CalendarSyncResult,
): Promise<string | null> {
  const { events, nextSyncToken } = await listAll(client, { syncToken });
  for (const ev of events) {
    result.fetched++;
    await processEvent(ev, config, result);
  }
  return nextSyncToken;
}

export async function runCalendarSync(args: {
  config: Config;
  client: CalendarClient;
  force?: boolean;
}): Promise<CalendarSyncResult> {
  const { config, client } = args;
  const result: CalendarSyncResult = {
    status: "ok",
    fetched: 0,
    upserted: 0,
    cancelled: 0,
    errors: 0,
    syncTokenAfter: null,
    resyncedFromBootstrap: false,
  };

  const state = await loadOrInitState();
  if (state.get("pausedAt") && !args.force) {
    return {
      ...result,
      status: "paused",
      message: (state.get("lastError") as string | null) ?? "paused",
    };
  }

  const startToken = state.get("syncToken") as string | null;

  try {
    let after: string | null;
    try {
      after = startToken
        ? await incremental(startToken, client, config, result)
        : await bootstrap(client, config, result);
    } catch (err) {
      if (err instanceof SyncTokenExpired) {
        logger.warn("gcal: syncToken expired; clearing and re-bootstrapping");
        await clearSyncToken();
        result.resyncedFromBootstrap = true;
        after = await bootstrap(client, config, result);
      } else {
        throw err;
      }
    }
    result.syncTokenAfter = after;
    await recordRun(after);
    return result;
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.code === "invalid_grant") {
        await pauseWith("invalid_grant");
        return {
          ...result,
          status: "paused",
          message: "invalid_grant — re-grant required",
        };
      }
      if (err.code === "no_grant") {
        return {
          ...result,
          status: "no_grant",
          message: "no Google OAuth grant on file",
        };
      }
    }
    if (err instanceof CalendarHttpError && err.status === 401) {
      await pauseWith("invalid_grant");
      return {
        ...result,
        status: "paused",
        message: "calendar returned 401 — re-grant required",
      };
    }
    if (err instanceof GoogleRequestTimeoutError) {
      await recordFailedRun(err.code);
      logger.error({ err, code: err.code }, "gcal sync timed out");
      return { ...result, status: "error", message: err.code };
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordFailedRun(message);
    logger.error({ err }, "gcal sync failed");
    return { ...result, status: "error", message };
  }
}

export async function runCalendarSyncOnce(config: Config): Promise<CalendarSyncResult> {
  const { makeCalendarClient } = await import("./calendar-client.js");
  const { getAccessToken } = await import("../lib/google-auth.js");
  const client = makeCalendarClient(() => getAccessToken(config));
  return runCalendarSync({ config, client });
}
