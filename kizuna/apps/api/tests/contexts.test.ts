import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Interaction } from "../src/db/models/Interaction.js";
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
  await Promise.all([Person.deleteMany({}), Interaction.deleteMany({})]);
});

async function seed() {
  const sarah = await Person.create({
    displayName: "Sarah",
    primaryEmail: "sarah@acme.com",
    source: "concierge",
  });
  const bob = await Person.create({
    displayName: "Bob",
    primaryEmail: "bob@bar.com",
    source: "concierge",
  });
  const me = await Person.create({
    displayName: "Me",
    primaryEmail: "me@example.com",
    source: "concierge",
  });

  // 3 acme-redesign + 1 trip:tokyo + 1 conf:strangeloop
  for (let i = 0; i < 3; i++) {
    await Interaction.create({
      occurredAt: new Date(`2026-02-${10 + i}T12:00:00Z`),
      channel: "email",
      title: `Acme ${i}`,
      participants: [
        { personId: sarah._id, role: "from" },
        { personId: me._id, role: "to" },
      ],
      context: ["project:acme-redesign"],
      source: "concierge",
    });
  }
  await Interaction.create({
    occurredAt: new Date("2026-02-15T12:00:00Z"),
    channel: "email",
    title: "Tokyo",
    participants: [
      { personId: bob._id, role: "from" },
      { personId: me._id, role: "to" },
    ],
    context: ["trip:tokyo-jan26", "project:acme-redesign"],
    source: "concierge",
  });
  await Interaction.create({
    occurredAt: new Date("2026-02-16T12:00:00Z"),
    channel: "in_person",
    title: "Strangeloop",
    participants: [
      { personId: bob._id, role: "attendee" },
      { personId: me._id, role: "attendee" },
    ],
    context: ["conf:strangeloop-2025"],
    source: "concierge",
  });

  return {
    sarahId: (sarah._id as { toHexString(): string }).toHexString(),
    bobId: (bob._id as { toHexString(): string }).toHexString(),
  };
}

describe("GET /contexts", () => {
  it("returns empty when no interactions exist", async () => {
    const res = await request(h.app).get("/contexts");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("aggregates distinct context tags + counts, sorted desc", async () => {
    await seed();
    const res = await request(h.app).get("/contexts");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { tag: "project:acme-redesign", count: 4 },
      { tag: "conf:strangeloop-2025", count: 1 },
      { tag: "trip:tokyo-jan26", count: 1 },
    ]);
  });

  it("filters by personId via participants.personId", async () => {
    const { bobId } = await seed();
    const res = await request(h.app).get(`/contexts?personId=${bobId}`);
    expect(res.body.items).toEqual([
      // bob has trip:tokyo + acme-redesign (1 each) + strangeloop (1)
      { tag: "conf:strangeloop-2025", count: 1 },
      { tag: "project:acme-redesign", count: 1 },
      { tag: "trip:tokyo-jan26", count: 1 },
    ]);
  });

  it("excludes tombstoned + cancelled interactions", async () => {
    await seed();
    await Interaction.updateOne({ title: "Tokyo" }, { $set: { deletedAt: new Date() } });
    await Interaction.updateOne({ title: "Strangeloop" }, { $set: { status: "cancelled" } });
    const res = await request(h.app).get("/contexts");
    const tags = res.body.items.map((r: { tag: string }) => r.tag);
    expect(tags).not.toContain("trip:tokyo-jan26");
    expect(tags).not.toContain("conf:strangeloop-2025");
    expect(tags).toContain("project:acme-redesign");
  });
});
