import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { Interaction } from "../src/db/models/Interaction.js";
import { Person } from "../src/db/models/Person.js";
import { SyncState } from "../src/db/models/SyncState.js";
import { runCalendarSync } from "../src/ingest/calendar.js";
import type { CalendarEvent } from "../src/ingest/parse-event.js";
import { FakeCalendarClient } from "./helpers/fake-calendar.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

let h: TestHarness;

function makeConfig(): Config {
  return loadConfig({
    MONGO_URI: h.uri,
    USER_EMAILS: "me@example.com",
    KIZUNA_OAUTH_ENCRYPTION_KEY: h.encryptionKey,
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://api.kizuna.localhost/oauth/google/callback",
  });
}

const baseEvent = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  id: "evt-1",
  status: "confirmed",
  summary: "Q2 planning",
  description: "review the deck",
  location: "Acme HQ",
  start: { dateTime: "2026-02-10T15:00:00-05:00" },
  end: { dateTime: "2026-02-10T16:00:00-05:00" },
  organizer: { email: "me@example.com", displayName: "Me" },
  attendees: [
    { email: "me@example.com", organizer: true, displayName: "Me" },
    { email: "sarah@acme.com", displayName: "Sarah Connor" },
  ],
  ...overrides,
});

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([Person.deleteMany({}), Interaction.deleteMany({}), SyncState.deleteMany({})]);
});

describe("runCalendarSync — skip-self on group events", () => {
  it("drops user from attendee role when ≥ 2 others", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap(
      [
        baseEvent({
          attendees: [
            { email: "me@example.com", organizer: true },
            { email: "sarah@acme.com", displayName: "Sarah" },
            { email: "bob@bar.com", displayName: "Bob" },
          ],
        }),
      ],
      "sync-1",
    );
    await runCalendarSync({
      config: makeConfig(),
      client,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ personId: { toHexString(): string }; role: string }>;
    }>;
    const people = (await Person.find().lean()) as unknown as Array<{
      _id: { toHexString(): string };
      primaryEmail: string;
    }>;
    const meId = people.find((p) => p.primaryEmail === "me@example.com")!._id.toHexString();
    const attendeeParts = ints[0]!.participants.filter((p) => p.role === "attendee");
    const attendeeIds = attendeeParts.map((p) => p.personId.toHexString());
    expect(attendeeIds).not.toContain(meId);
    // Organizer (also 'me') keeps the 'from' role per skip-self contract.
    const fromParts = ints[0]!.participants.filter((p) => p.role === "from");
    expect(fromParts.map((p) => p.personId.toHexString())).toContain(meId);
  });

  it("keeps user attendee on a 1:1 event", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap(
      [
        baseEvent({
          organizer: { email: "sarah@acme.com", displayName: "Sarah" },
          attendees: [{ email: "sarah@acme.com", organizer: true }, { email: "me@example.com" }],
        }),
      ],
      "sync-1",
    );
    await runCalendarSync({
      config: makeConfig(),
      client,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ role: string }>;
    }>;
    expect(ints[0]!.participants.length).toBe(2);
  });
});

describe("runCalendarSync — bootstrap", () => {
  it("inserts events as calendar interactions with sourceRef", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap(
      [baseEvent({}), baseEvent({ id: "evt-2", summary: "lunch" })],
      "sync-tok-1",
    );
    const r = await runCalendarSync({
      config: makeConfig(),
      client,
    });
    expect(r.status).toBe("ok");
    expect(r.fetched).toBe(2);
    expect(r.upserted).toBe(2);
    expect(r.syncTokenAfter).toBe("sync-tok-1");

    const ints = (await Interaction.find().sort({ occurredAt: 1 }).lean()) as unknown as Array<{
      channel: string;
      source: string;
      sourceRef: { provider: string; id: string };
      title: string;
      location: string | null;
      status: string;
    }>;
    expect(ints.length).toBe(2);
    expect(ints.every((i) => i.channel === "calendar")).toBe(true);
    expect(ints.every((i) => i.source === "gcal-sync")).toBe(true);
    expect(ints.map((i) => i.sourceRef.id).sort()).toEqual(["evt-1", "evt-2"]);

    const state = await SyncState.findOne({ provider: "gcal" }).lean();
    expect(state?.syncToken).toBe("sync-tok-1");
    expect(state?.pausedAt).toBeNull();
  });

  it("upserts attendees + organizer with role from / attendee", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    await runCalendarSync({
      config: makeConfig(),
      client,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ role: string }>;
    }>;
    expect(ints.length).toBe(1);
    const roles = ints[0]!.participants.map((p) => p.role).sort();
    expect(roles).toEqual(["attendee", "from"]);

    const people = (await Person.find().sort({ primaryEmail: 1 }).lean()) as unknown as Array<{
      primaryEmail: string;
      source: string;
    }>;
    expect(people.map((p) => p.primaryEmail)).toEqual(["me@example.com", "sarah@acme.com"]);
    expect(people.every((p) => p.source === "gcal-sync")).toBe(true);
  });
});

describe("runCalendarSync — reconciliation", () => {
  it("replay is idempotent: title/time/location preserved across re-ingest", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    const config = makeConfig();
    await runCalendarSync({ config, client });

    // Reset state and re-deliver the same event.
    await SyncState.updateOne({ provider: "gcal" }, { $set: { syncToken: null } });
    client.enqueueBootstrap([baseEvent({})], "sync-2");
    const second = await runCalendarSync({
      config,
      client,
    });
    expect(second.upserted).toBe(1);
    expect(await Interaction.countDocuments()).toBe(1);
  });

  it("overwrites title / time / location on an edited event", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    const config = makeConfig();
    await runCalendarSync({ config, client });

    // Incremental: same eventId, new title + time + location.
    client.enqueueIncremental(
      [
        baseEvent({
          summary: "Q2 planning (updated)",
          location: "Conf Room B",
          start: { dateTime: "2026-02-11T09:00:00-05:00" },
        }),
      ],
      "sync-2",
    );
    await runCalendarSync({ config, client });

    const docs = (await Interaction.find().lean()) as unknown as Array<{
      title: string;
      location: string | null;
      occurredAt: Date;
    }>;
    expect(docs.length).toBe(1);
    expect(docs[0]!.title).toBe("Q2 planning (updated)");
    expect(docs[0]!.location).toBe("Conf Room B");
    expect(docs[0]!.occurredAt.toISOString()).toBe("2026-02-11T14:00:00.000Z");
  });

  it("reconciles attendees on edit (added + removed)", async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    const config = makeConfig();
    await runCalendarSync({ config, client });

    // Replace attendees: drop sarah, add bob.
    client.enqueueIncremental(
      [
        baseEvent({
          attendees: [
            { email: "me@example.com", organizer: true, displayName: "Me" },
            { email: "bob@bar.com", displayName: "Bob" },
          ],
        }),
      ],
      "sync-2",
    );
    await runCalendarSync({ config, client });

    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ personId: { toHexString(): string } }>;
    }>;
    expect(ints.length).toBe(1);

    const people = (await Person.find().lean()) as unknown as Array<{
      _id: { toHexString(): string };
      primaryEmail: string;
    }>;
    const byEmail = new Map(people.map((p) => [p.primaryEmail, p._id.toHexString()]));
    const ids = ints[0]!.participants.map((p) => p.personId.toHexString()).sort();
    const expected = [byEmail.get("bob@bar.com")!, byEmail.get("me@example.com")!].sort();
    expect(ids).toEqual(expected);
  });

  it('flips status to "cancelled" on a cancellation event', async () => {
    const client = new FakeCalendarClient();
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    const config = makeConfig();
    await runCalendarSync({ config, client });

    client.enqueueIncremental([baseEvent({ status: "cancelled" })], "sync-2");
    const r = await runCalendarSync({
      config,
      client,
    });
    expect(r.cancelled).toBe(1);

    const doc = (await Interaction.findOne({
      "sourceRef.id": "evt-1",
    }).lean()) as unknown as { status: string };
    expect(doc.status).toBe("cancelled");
    // Default list excludes cancelled (filtered in route layer).
    // The audit-trail row still exists.
    expect(await Interaction.countDocuments()).toBe(1);
  });

  it("does not bump lastInteractionAt when an event is cancelled", async () => {
    const client = new FakeCalendarClient();
    // Original event at T1 → updates lastInteractionAt.
    client.enqueueBootstrap([baseEvent({})], "sync-1");
    const config = makeConfig();
    await runCalendarSync({ config, client });
    const sarahBefore = (await Person.findOne({
      primaryEmail: "sarah@acme.com",
    }).lean()) as unknown as { lastInteractionAt: Date };
    const initialLast = sarahBefore.lastInteractionAt.toISOString();

    // Cancellation arrives later but should not register as a new touchpoint.
    client.enqueueIncremental(
      [
        baseEvent({
          status: "cancelled",
          start: { dateTime: "2026-12-01T15:00:00-05:00" },
        }),
      ],
      "sync-2",
    );
    await runCalendarSync({ config, client });

    const sarahAfter = (await Person.findOne({
      primaryEmail: "sarah@acme.com",
    }).lean()) as unknown as { lastInteractionAt: Date };
    expect(sarahAfter.lastInteractionAt.toISOString()).toBe(initialLast);
  });
});

describe("runCalendarSync — sync-token expiration", () => {
  it("on 410 Gone, clears syncToken and re-bootstraps", async () => {
    // Pre-seed state so the first call goes incremental.
    await SyncState.create({
      provider: "gcal",
      syncToken: "old-token",
      source: "gcal-sync",
    });
    const client = new FakeCalendarClient();
    client.throwSyncTokenExpiredOnce(); // first listEvents throws
    client.enqueueBootstrap([baseEvent({})], "sync-fresh"); // re-bootstrap call

    const r = await runCalendarSync({
      config: makeConfig(),
      client,
    });
    expect(r.status).toBe("ok");
    expect(r.resyncedFromBootstrap).toBe(true);
    expect(r.upserted).toBe(1);
    expect(r.syncTokenAfter).toBe("sync-fresh");
  });
});

describe("runCalendarSync — invalid_grant", () => {
  it("pauses on a 401 from Calendar", async () => {
    const client = new FakeCalendarClient();
    client.throw401Once();
    const r = await runCalendarSync({
      config: makeConfig(),
      client,
    });
    expect(r.status).toBe("paused");
    const state = await SyncState.findOne({ provider: "gcal" }).lean();
    expect(state?.pausedAt).not.toBeNull();
    expect(state?.lastError).toBe("invalid_grant");
  });

  it("respects the pause until force=true is passed", async () => {
    await SyncState.create({
      provider: "gcal",
      syncToken: "tok",
      pausedAt: new Date(),
      lastError: "invalid_grant",
      source: "gcal-sync",
    });
    const client = new FakeCalendarClient();
    const r = await runCalendarSync({
      config: makeConfig(),
      client,
    });
    expect(r.status).toBe("paused");

    client.enqueueIncremental([], "sync-fresh");
    const forced = await runCalendarSync({
      config: makeConfig(),
      client,
      force: true,
    });
    expect(forced.status).toBe("ok");
  });
});

describe("runCalendarSync — request timeout", () => {
  it("records a stable timeout code and does not advance the sync token", async () => {
    const client = new FakeCalendarClient();
    client.throwTimeoutOnce();

    const r = await runCalendarSync({
      config: makeConfig(),
      client,
    });

    expect(r.status).toBe("error");
    expect(r.message).toBe("gcal_request_timeout");
    expect(r.syncTokenAfter).toBeNull();
    const state = await SyncState.findOne({ provider: "gcal" }).lean();
    expect(state?.syncToken).toBeNull();
    expect(state?.lastError).toBe("gcal_request_timeout");
    expect(state?.errorCount).toBe(1);
  });
});
