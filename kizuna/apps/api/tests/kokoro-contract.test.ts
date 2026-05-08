import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Followup } from "../src/db/models/Followup.js";
import { Interaction } from "../src/db/models/Interaction.js";
import { Person } from "../src/db/models/Person.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

let h: TestHarness;

const testDir = dirname(fileURLToPath(import.meta.url));
const get = (p: string) => request(h.app).get(p);
const post = (p: string, body?: object) => request(h.app).post(p).send(body);

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([Person.deleteMany({}), Interaction.deleteMany({}), Followup.deleteMany({})]);
});

async function makePerson(input: {
  displayName: string;
  primaryEmail?: string;
  emails?: string[];
  handles?: Record<string, string>;
  tags?: string[];
  notes?: string;
  lastInteractionAt?: string;
}) {
  const doc = await Person.create({
    ...input,
    source: "concierge",
    ...(input.lastInteractionAt ? { lastInteractionAt: new Date(input.lastInteractionAt) } : {}),
  });
  return doc._id.toHexString();
}

describe("Kokoro identity people search contract", () => {
  it("searches stable identity fields, excludes notes/tags, and sorts by relevance bucket", async () => {
    await makePerson({ displayName: "Sarah", lastInteractionAt: "2020-01-01T00:00:00Z" });
    await makePerson({
      displayName: "Sarah Older",
      lastInteractionAt: "2025-01-01T00:00:00Z",
    });
    await makePerson({
      displayName: "Sarah Newer",
      lastInteractionAt: "2026-01-01T00:00:00Z",
    });
    await makePerson({ displayName: "Team Sarah", lastInteractionAt: "2026-02-01T00:00:00Z" });
    await makePerson({ displayName: "Nosarah", lastInteractionAt: "2026-03-01T00:00:00Z" });
    await makePerson({
      displayName: "Notes Only",
      tags: ["sarah"],
      notes: "Sarah is mentioned here but is not this person's identity.",
      lastInteractionAt: "2026-04-01T00:00:00Z",
    });

    const res = await get("/v1/people?identityQuery=sarah&limit=20");

    expect(res.status).toBe(200);
    expect((res.body.items as Array<{ displayName: string }>).map((p) => p.displayName)).toEqual([
      "Sarah",
      "Sarah Newer",
      "Sarah Older",
      "Team Sarah",
      "Nosarah",
    ]);
  });

  it("matches primaryEmail, secondary emails, and handle values", async () => {
    await makePerson({ displayName: "Primary Email", primaryEmail: "primary@example.com" });
    await makePerson({
      displayName: "Secondary Email",
      emails: ["secondary@example.com"],
    });
    await makePerson({
      displayName: "Handle Match",
      handles: { telegram: "@sarah-handle" },
    });

    const primary = await get("/v1/people?identityQuery=PRIMARY%40EXAMPLE.COM");
    expect(primary.body.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      "Primary Email",
    ]);

    const secondary = await get("/v1/people?identityQuery=secondary%40example.com");
    expect(secondary.body.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      "Secondary Email",
    ]);

    const handle = await get("/v1/people?identityQuery=%40sarah-handle");
    expect(handle.body.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      "Handle Match",
    ]);
  });

  it("matches stored values with non-canonical whitespace against a canonical query", async () => {
    await makePerson({ displayName: "John  Smith", lastInteractionAt: "2026-01-01T00:00:00Z" });
    await makePerson({ displayName: "Jane\tDoe", lastInteractionAt: "2026-02-01T00:00:00Z" });

    const exact = await get("/v1/people?identityQuery=john%20smith");
    expect(exact.body.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      "John  Smith",
    ]);

    const tabbed = await get("/v1/people?identityQuery=jane%20doe");
    expect(tabbed.body.items.map((p: { displayName: string }) => p.displayName)).toEqual([
      "Jane\tDoe",
    ]);
  });

  it("rejects combining identityQuery with the broad query search", async () => {
    const res = await get("/v1/people?identityQuery=sarah&query=notes");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("paginates identity search in deterministic relevance order", async () => {
    await makePerson({ displayName: "Sarah A", lastInteractionAt: "2026-03-01T00:00:00Z" });
    await makePerson({ displayName: "Sarah B", lastInteractionAt: "2026-02-01T00:00:00Z" });
    await makePerson({ displayName: "Sarah C", lastInteractionAt: "2026-01-01T00:00:00Z" });

    const first = await get("/v1/people?identityQuery=sarah&limit=2");
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await get(
      `/v1/people?identityQuery=sarah&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );

    expect([
      ...first.body.items.map((p: { displayName: string }) => p.displayName),
      ...second.body.items.map((p: { displayName: string }) => p.displayName),
    ]).toEqual(["Sarah A", "Sarah B", "Sarah C"]);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it("declares model indexes for identity-search fields", () => {
    const indexes = Person.schema.indexes().map(([fields]) => fields);

    expect(indexes).toContainEqual({ primaryEmail: 1 });
    expect(indexes).toContainEqual({ displayName: 1 });
    expect(indexes).toContainEqual({ emails: 1 });
    expect(indexes).toContainEqual({ "handles.$**": 1 });
  });
});

describe("Kokoro interaction event-time sort contract", () => {
  it("sorts list interactions by occurredAt desc with _id desc as tie-breaker", async () => {
    const person = await post("/v1/people", { displayName: "A" });
    await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "older",
      participants: [{ personId: person.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-03T00:00:00Z",
      channel: "email",
      title: "newer",
      participants: [{ personId: person.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-03T00:00:00Z",
      channel: "email",
      title: "same-time-newer-id",
      participants: [{ personId: person.body.id, role: "from" }],
    });

    const res = await get("/v1/interactions?sort=occurredAt:-1");

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual([
      "same-time-newer-id",
      "newer",
      "older",
    ]);
  });

  it("paginates occurredAt desc sort with a compound cursor", async () => {
    const person = await post("/v1/people", { displayName: "A" });
    for (const [title, occurredAt] of [
      ["oldest", "2026-01-01T00:00:00Z"],
      ["middle", "2026-01-02T00:00:00Z"],
      ["newest", "2026-01-03T00:00:00Z"],
    ]) {
      await post("/v1/interactions", {
        occurredAt,
        channel: "email",
        title,
        participants: [{ personId: person.body.id, role: "from" }],
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await get(
        `/v1/interactions?sort=occurredAt:-1&limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      expect(res.status).toBe(200);
      seen.push(res.body.items[0].title);
      cursor = res.body.nextCursor;
    }

    expect(seen).toEqual(["newest", "middle", "oldest"]);
    expect(cursor).toBeUndefined();
  });

  it("supports occurredAt desc sort on the person interactions route", async () => {
    const person = await post("/v1/people", { displayName: "A" });
    await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "older",
      participants: [{ personId: person.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-02T00:00:00Z",
      channel: "email",
      title: "newer",
      participants: [{ personId: person.body.id, role: "from" }],
    });

    const res = await get(`/v1/people/${person.body.id}/interactions?sort=occurredAt:-1`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(["newer", "older"]);
  });
});

describe("Kokoro followup due-priority sort contract", () => {
  it("sorts due followups first, oldest due first, then null dueAt rows", async () => {
    const person = await post("/v1/people", { displayName: "A" });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "undated",
    });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "newer due",
      dueAt: "2026-01-10T00:00:00Z",
    });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "older due",
      dueAt: "2026-01-01T00:00:00Z",
    });

    const res = await get("/v1/followups?sort=duePriority:1");

    expect(res.status).toBe(200);
    expect(res.body.items.map((f: { reason: string }) => f.reason)).toEqual([
      "older due",
      "newer due",
      "undated",
    ]);
  });

  it("paginates due-priority sort across the due/null bucket boundary", async () => {
    const person = await post("/v1/people", { displayName: "A" });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "undated",
    });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "due 2",
      dueAt: "2026-01-02T00:00:00Z",
    });
    await post("/v1/followups", {
      personId: person.body.id,
      direction: "i_owe",
      reason: "due 1",
      dueAt: "2026-01-01T00:00:00Z",
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const res = await get(
        `/v1/followups?sort=duePriority:1&limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      expect(res.status).toBe(200);
      seen.push(res.body.items[0].reason);
      cursor = res.body.nextCursor;
    }

    expect(seen).toEqual(["due 1", "due 2", "undated"]);
    expect(cursor).toBeUndefined();
  });

  it("declares a supporting due-priority pagination index", () => {
    const indexes = Followup.schema.indexes().map(([, options]) => options?.name);

    expect(indexes).toContain("followups_due_priority_page");
  });
});

describe("Kokoro manifest contract", () => {
  it("matches the checked-in v1 manifest fixture", async () => {
    const expected = JSON.parse(
      await readFile(resolve(testDir, "fixtures/manifest.v1.json"), "utf8"),
    ) as unknown;

    const res = await get("/v1/_manifest");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);
  });
});
