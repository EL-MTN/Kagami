import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
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
  await Person.deleteMany({});
});

async function makePerson(name: string, lastInteractionAt: Date | null) {
  const p = await Person.create({
    displayName: name,
    primaryEmail: `${name.toLowerCase()}@example.com`,
    source: "concierge",
    ...(lastInteractionAt ? { lastInteractionAt } : {}),
  });
  return (p._id as { toHexString(): string }).toHexString();
}

describe("GET /v1/people?sort=lastInteractionAt:-1", () => {
  it("sorts non-null lastInteractionAt rows newest-first", async () => {
    await makePerson("Old", new Date("2025-01-01T00:00:00Z"));
    await makePerson("Newer", new Date("2026-03-01T00:00:00Z"));
    await makePerson("Newest", new Date("2026-04-01T00:00:00Z"));
    const res = await request(h.app)
      .get("/v1/people?sort=lastInteractionAt:-1")
      ;
    expect(res.status).toBe(200);
    expect((res.body.items as Array<{ displayName: string }>).map((p) => p.displayName)).toEqual([
      "Newest",
      "Newer",
      "Old",
    ]);
  });

  it("places null lastInteractionAt rows after non-null", async () => {
    await makePerson("Touched", new Date("2026-04-01T00:00:00Z"));
    await makePerson("NeverA", null);
    await makePerson("NeverB", null);
    const res = await request(h.app)
      .get("/v1/people?sort=lastInteractionAt:-1")
      ;
    const names = (res.body.items as Array<{ displayName: string }>).map((p) => p.displayName);
    expect(names[0]).toBe("Touched");
    expect(names.slice(1).sort()).toEqual(["NeverA", "NeverB"]);
  });

  it("paginates correctly across the null-bucket boundary", async () => {
    await makePerson("A", new Date("2026-04-01T00:00:00Z"));
    await makePerson("B", new Date("2026-03-01T00:00:00Z"));
    await makePerson("C", null);
    await makePerson("D", null);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const path = `/v1/people?sort=lastInteractionAt:-1&limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await request(h.app).get(path);
      if (res.body.items.length === 0) break;
      seen.push(res.body.items[0].displayName);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["A", "B", expect.any(String), expect.any(String)]);
    expect(seen.slice(2).sort()).toEqual(["C", "D"]);
  });

  it("falls back to _id:-1 sort by default (back-compat)", async () => {
    await makePerson("X", new Date("2025-01-01T00:00:00Z"));
    await makePerson("Y", new Date("2026-04-01T00:00:00Z"));
    const res = await request(h.app).get("/v1/people");
    // Default _id:-1 sort: most recently created first.
    expect((res.body.items as Array<{ displayName: string }>).map((p) => p.displayName)).toEqual([
      "Y",
      "X",
    ]);
  });
});
