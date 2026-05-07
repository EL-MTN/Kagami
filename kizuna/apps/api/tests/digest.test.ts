import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Followup } from "../src/db/models/Followup.js";
import { Person } from "../src/db/models/Person.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([Person.deleteMany({}), Followup.deleteMany({})]);
});

async function createPerson(name: string) {
  const p = await Person.create({
    displayName: name,
    primaryEmail: `${name.toLowerCase()}@example.com`,
    source: "concierge",
  });
  return (p._id as { toHexString(): string }).toHexString();
}

async function createFollowup(opts: {
  personId: string;
  reason: string;
  dueAt: Date;
  status?: "open" | "done";
}) {
  await Followup.create({
    personId: opts.personId,
    direction: "i_owe",
    reason: opts.reason,
    dueAt: opts.dueAt,
    status: opts.status ?? "open",
    source: "concierge",
  });
}

describe("GET /v1/digest", () => {
  it("returns empty arrays when nothing is open", async () => {
    const res = await request(h.app).get("/v1/digest");
    expect(res.status).toBe(200);
    expect(res.body.window).toBe("P7D");
    expect(res.body.overdue).toEqual([]);
    expect(res.body.upcoming).toEqual([]);
    expect(res.body.windowEnd).toBeTruthy();
  });

  it("partitions followups into overdue vs upcoming inside the default window", async () => {
    const sarah = await createPerson("Sarah");
    const bob = await createPerson("Bob");
    const now = Date.now();

    await createFollowup({
      personId: sarah,
      reason: "send the deck",
      dueAt: new Date(now - 86_400_000), // yesterday
    });
    await createFollowup({
      personId: bob,
      reason: "lunch",
      dueAt: new Date(now + 3 * 86_400_000), // +3d
    });
    await createFollowup({
      personId: sarah,
      reason: "distant",
      dueAt: new Date(now + 30 * 86_400_000), // +30d, outside default
    });

    const res = await request(h.app).get("/v1/digest");
    expect(res.status).toBe(200);
    expect(res.body.overdue.map((f: { reason: string }) => f.reason)).toEqual(["send the deck"]);
    expect(res.body.upcoming.map((f: { reason: string }) => f.reason)).toEqual(["lunch"]);
  });

  it("respects ?window=P30D", async () => {
    const sarah = await createPerson("Sarah");
    await createFollowup({
      personId: sarah,
      reason: "distant",
      dueAt: new Date(Date.now() + 20 * 86_400_000),
    });
    const res = await request(h.app).get("/v1/digest?window=P30D");
    expect(res.body.upcoming.map((f: { reason: string }) => f.reason)).toEqual(["distant"]);
  });

  it('accepts the short "7d" form', async () => {
    const res = await request(h.app).get("/v1/digest?window=7d");
    expect(res.status).toBe(200);
    expect(res.body.window).toBe("7d");
  });

  it("hydrates each followup with its person", async () => {
    const sarah = await createPerson("Sarah");
    await createFollowup({
      personId: sarah,
      reason: "note",
      dueAt: new Date(Date.now() + 86_400_000),
    });
    const res = await request(h.app).get("/v1/digest");
    expect(res.body.upcoming[0].person).toMatchObject({
      id: sarah,
      displayName: "Sarah",
      primaryEmail: "sarah@example.com",
    });
  });

  it("excludes done / dismissed / tombstoned followups", async () => {
    const sarah = await createPerson("Sarah");
    await createFollowup({
      personId: sarah,
      reason: "done one",
      dueAt: new Date(Date.now() - 1000),
      status: "done",
    });
    await Followup.create({
      personId: sarah,
      direction: "i_owe",
      reason: "tombstoned one",
      dueAt: new Date(Date.now() - 1000),
      status: "open",
      deletedAt: new Date(),
      source: "concierge",
    });
    const res = await request(h.app).get("/v1/digest");
    expect(res.body.overdue).toEqual([]);
    expect(res.body.upcoming).toEqual([]);
  });

  it("rejects an invalid window with 400", async () => {
    const res = await request(h.app).get("/v1/digest?window=garbage");
    expect(res.status).toBe(400);
  });

  it("appears in the manifest", async () => {
    const res = await request(h.app).get("/v1/_manifest");
    const names = (res.body.endpoints as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain("get_digest");
  });
});
