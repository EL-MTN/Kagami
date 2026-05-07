import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Followup } from "../src/db/models/Followup.js";
import { Interaction } from "../src/db/models/Interaction.js";
import { Organization } from "../src/db/models/Organization.js";
import { Person } from "../src/db/models/Person.js";
import { startHarness, type TestHarness } from "./helpers/harness.js";

let h: TestHarness;
const get = (p: string) => request(h.app).get(p);
const post = (p: string, body?: object) => request(h.app).post(p).send(body);
const patch = (p: string, body?: object) => request(h.app).patch(p).send(body);
const del = (p: string) => request(h.app).delete(p);

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([
    Person.deleteMany({}),
    Organization.deleteMany({}),
    Interaction.deleteMany({}),
    Followup.deleteMany({}),
  ]);
});

describe("people CRUD", () => {
  it("creates a person with source=concierge and firstSeen set", async () => {
    const r = await post("/v1/people", {
      displayName: "Sarah Connor",
      primaryEmail: "Sarah@Example.com",
      tags: ["friend", "mentor"],
      handles: { twitter: "@sarah" },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      displayName: "Sarah Connor",
      primaryEmail: "sarah@example.com",
      tags: ["friend", "mentor"],
      handles: { twitter: "@sarah" },
      source: "concierge",
      suppressReingest: false,
    });
    expect(r.body.id).toMatch(/^[a-f0-9]{24}$/);
    expect(r.body.firstSeen).toBeTruthy();
    expect(r.body.deletedAt).toBeNull();
  });

  it("rejects unknown fields with 400 (Zod strict)", async () => {
    const r = await post("/v1/people", {
      displayName: "X",
      bogus: "nope",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
  });

  it("rejects malformed email with 400", async () => {
    const r = await post("/v1/people", {
      displayName: "X",
      primaryEmail: "not-an-email",
    });
    expect(r.status).toBe(400);
  });

  it("GET by id returns the same shape; tombstoned id 404s", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const r = await get(`/v1/people/${a.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(a.body.id);

    await del(`/v1/people/${a.body.id}`);
    const r2 = await get(`/v1/people/${a.body.id}`);
    expect(r2.status).toBe(404);
  });

  it("PATCH updates a subset of fields and rejects unknown fields", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const r = await patch(`/v1/people/${a.body.id}`, {
      relationship: "colleague",
      tags: ["work"],
    });
    expect(r.status).toBe(200);
    expect(r.body.relationship).toBe("colleague");
    expect(r.body.tags).toEqual(["work"]);

    const r2 = await patch(`/v1/people/${a.body.id}`, { firstSeen: new Date().toISOString() });
    expect(r2.status).toBe(400);
  });

  it("DELETE tombstones and sets suppressReingest=true", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const r = await del(`/v1/people/${a.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.suppressReingest).toBe(true);
    expect(r.body.deletedAt).toBeTruthy();
  });

  it("list excludes tombstoned by default; includeTombstoned=true shows them", async () => {
    const live = await post("/v1/people", { displayName: "Live" });
    const dead = await post("/v1/people", { displayName: "Dead" });
    await del(`/v1/people/${dead.body.id}`);

    const r1 = await get("/v1/people");
    expect(r1.body.items.map((p: { id: string }) => p.id)).toEqual([live.body.id]);

    const r2 = await get("/v1/people?includeTombstoned=true");
    const ids = r2.body.items.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual([live.body.id, dead.body.id].sort());
  });

  it("list filters by tag (AND of repeated tag params)", async () => {
    const a = await post("/v1/people", { displayName: "A", tags: ["x", "y"] });
    await post("/v1/people", { displayName: "B", tags: ["x"] });
    const r = await get("/v1/people?tag=x&tag=y");
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([a.body.id]);
  });

  it("list filters by orgId", async () => {
    const o = await post("/v1/organizations", { name: "Acme" });
    const a = await post("/v1/people", { displayName: "A", primaryOrgId: o.body.id });
    await post("/v1/people", { displayName: "B" });
    const r = await get(`/v1/people?orgId=${o.body.id}`);
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([a.body.id]);
  });

  it("list paginates by cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await post("/v1/people", { displayName: `P${i}` });
      ids.push(r.body.id);
    }
    const r1 = await get("/v1/people?limit=1");
    expect(r1.body.items.length).toBe(1);
    expect(r1.body.nextCursor).toBeTruthy();
    const r2 = await get(`/v1/people?limit=1&cursor=${r1.body.nextCursor}`);
    expect(r2.body.items.length).toBe(1);
    expect(r2.body.nextCursor).toBeTruthy();
    const r3 = await get(`/v1/people?limit=1&cursor=${r2.body.nextCursor}`);
    expect(r3.body.items.length).toBe(1);
    expect(r3.body.nextCursor).toBeUndefined();

    const seen = [r1, r2, r3].map((r) => r.body.items[0].id);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("rejects malformed cursor with 400", async () => {
    const r = await get("/v1/people?cursor=not-base64-objectid");
    expect(r.status).toBe(400);
  });

  it("hasOpenFollowup=true filters to people with open followups", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const b = await post("/v1/people", { displayName: "B" });
    await post("/v1/followups", {
      personId: a.body.id,
      direction: "i_owe",
      reason: "send the deck",
    });
    const r = await get("/v1/people?hasOpenFollowup=true");
    expect(r.body.items.map((p: { id: string }) => p.id)).toEqual([a.body.id]);
    const r2 = await get("/v1/people?hasOpenFollowup=false");
    expect(r2.body.items.map((p: { id: string }) => p.id)).toEqual([b.body.id]);
  });
});

describe("organizations CRUD", () => {
  it("creates and patches an org", async () => {
    const r = await post("/v1/organizations", {
      name: "Acme",
      domain: "Acme.com",
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("Acme");
    expect(r.body.domain).toBe("acme.com");

    const r2 = await patch(`/v1/organizations/${r.body.id}`, { industry: "tech" });
    expect(r2.status).toBe(200);
    expect(r2.body.industry).toBe("tech");
  });

  it("rejects duplicate domain with 409", async () => {
    await post("/v1/organizations", { name: "A", domain: "dup.com" });
    const r = await post("/v1/organizations", { name: "B", domain: "dup.com" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });

  it("list filters by domain and excludes tombstoned by default", async () => {
    const o1 = await post("/v1/organizations", { name: "A", domain: "a.com" });
    const o2 = await post("/v1/organizations", { name: "B", domain: "b.com" });
    await del(`/v1/organizations/${o2.body.id}`);

    const r = await get("/v1/organizations?domain=a.com");
    expect(r.body.items.map((o: { id: string }) => o.id)).toEqual([o1.body.id]);
  });
});

describe("interactions + recordInteraction", () => {
  it("POST inserts and $max-updates lastInteractionAt on participants", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const b = await post("/v1/people", { displayName: "B" });
    const t1 = "2026-01-15T12:00:00Z";
    const r = await post("/v1/interactions", {
      occurredAt: t1,
      channel: "email",
      title: "Subject 1",
      body: "hi",
      participants: [
        { personId: a.body.id, role: "from" },
        { personId: b.body.id, role: "to" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("Subject 1");
    expect(r.body.source).toBe("concierge");
    expect(r.body.sourceRef).toBeNull();

    const ar = await get(`/v1/people/${a.body.id}`);
    const br = await get(`/v1/people/${b.body.id}`);
    expect(new Date(ar.body.lastInteractionAt).toISOString()).toBe(new Date(t1).toISOString());
    expect(new Date(br.body.lastInteractionAt).toISOString()).toBe(new Date(t1).toISOString());
  });

  it("does not roll back lastInteractionAt on an earlier interaction", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const t1 = "2026-02-01T00:00:00Z";
    const t0 = "2026-01-01T00:00:00Z";
    const t2 = "2026-03-01T00:00:00Z";

    await post("/v1/interactions", {
      occurredAt: t1,
      channel: "email",
      title: "one",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: t0,
      channel: "email",
      title: "earlier",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    let r = await get(`/v1/people/${a.body.id}`);
    expect(new Date(r.body.lastInteractionAt).toISOString()).toBe(new Date(t1).toISOString());

    await post("/v1/interactions", {
      occurredAt: t2,
      channel: "email",
      title: "later",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    r = await get(`/v1/people/${a.body.id}`);
    expect(new Date(r.body.lastInteractionAt).toISOString()).toBe(new Date(t2).toISOString());
  });

  it("rejects sourceRef in concierge writes (unknown field)", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const r = await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "x",
      participants: [{ personId: a.body.id, role: "from" }],
      sourceRef: { provider: "gmail", id: "123" },
    });
    expect(r.status).toBe(400);
  });

  it("rejects empty participants array", async () => {
    const r = await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "x",
      participants: [],
    });
    expect(r.status).toBe(400);
  });

  it("list filters by personId, channel, and date range", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const b = await post("/v1/people", { displayName: "B" });
    await post("/v1/interactions", {
      occurredAt: "2026-01-15T00:00:00Z",
      channel: "email",
      title: "A-jan",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-02-15T00:00:00Z",
      channel: "calendar",
      title: "A-feb",
      participants: [{ personId: a.body.id, role: "attendee" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-10T00:00:00Z",
      channel: "email",
      title: "B-jan",
      participants: [{ personId: b.body.id, role: "from" }],
    });

    const r1 = await get(`/v1/interactions?personId=${a.body.id}`);
    expect(r1.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["A-feb", "A-jan"]);

    const r2 = await get(`/v1/interactions?channel=email`);
    expect(r2.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["A-jan", "B-jan"]);

    const r3 = await get(
      `/v1/interactions?occurredAfter=2026-01-31T00:00:00Z&occurredBefore=2026-03-01T00:00:00Z`,
    );
    expect(r3.body.items.map((i: { title: string }) => i.title)).toEqual(["A-feb"]);
  });

  it("list filters by orgId via participant→primaryOrg join", async () => {
    const org = await post("/v1/organizations", { name: "Acme" });
    const a = await post("/v1/people", {
      displayName: "A",
      primaryOrgId: org.body.id,
    });
    const b = await post("/v1/people", { displayName: "B" });
    await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "A-msg",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-02T00:00:00Z",
      channel: "email",
      title: "B-msg",
      participants: [{ personId: b.body.id, role: "from" }],
    });
    const r = await get(`/v1/interactions?orgId=${org.body.id}`);
    expect(r.body.items.map((i: { title: string }) => i.title)).toEqual(["A-msg"]);
  });

  it("list filters by status (default active hides cancelled)", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const i1 = await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "calendar",
      title: "live",
      participants: [{ personId: a.body.id, role: "attendee" }],
    });
    // Manually flip one to cancelled to simulate calendar cancellation.
    await Interaction.updateOne({ _id: i1.body.id }, { $set: { status: "cancelled" } });
    const r1 = await get("/v1/interactions");
    expect(r1.body.items).toEqual([]);
    const r2 = await get("/v1/interactions?status=cancelled");
    expect(r2.body.items.length).toBe(1);
    const r3 = await get("/v1/interactions?status=any");
    expect(r3.body.items.length).toBe(1);
  });

  it("GET /v1/people/:id/interactions filters to that person", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const b = await post("/v1/people", { displayName: "B" });
    await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "mine",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    await post("/v1/interactions", {
      occurredAt: "2026-01-02T00:00:00Z",
      channel: "email",
      title: "theirs",
      participants: [{ personId: b.body.id, role: "from" }],
    });
    const r = await get(`/v1/people/${a.body.id}/interactions`);
    expect(r.body.items.map((i: { title: string }) => i.title)).toEqual(["mine"]);
  });

  it("DELETE tombstones and excludes from default list", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const i = await post("/v1/interactions", {
      occurredAt: "2026-01-01T00:00:00Z",
      channel: "email",
      title: "x",
      participants: [{ personId: a.body.id, role: "from" }],
    });
    const r = await del(`/v1/interactions/${i.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeTruthy();

    const r2 = await get("/v1/interactions");
    expect(r2.body.items.length).toBe(0);
    const r3 = await get("/v1/interactions?includeTombstoned=true");
    expect(r3.body.items.length).toBe(1);
  });
});

describe("followups CRUD", () => {
  it("creates a followup; list defaults to status=open", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const r = await post("/v1/followups", {
      personId: a.body.id,
      direction: "i_owe",
      reason: "send the deck",
      dueAt: "2026-04-01T00:00:00Z",
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("open");
    expect(r.body.direction).toBe("i_owe");

    const list = await get("/v1/followups");
    expect(list.body.items.length).toBe(1);
  });

  it("PATCH transitions status", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const f = await post("/v1/followups", {
      personId: a.body.id,
      direction: "they_owe",
      reason: "await reply",
    });
    const r = await patch(`/v1/followups/${f.body.id}`, { status: "done" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("done");

    const open = await get("/v1/followups");
    expect(open.body.items.length).toBe(0);
    const done = await get("/v1/followups?status=done");
    expect(done.body.items.length).toBe(1);
  });

  it("filters by direction", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    await post("/v1/followups", {
      personId: a.body.id,
      direction: "i_owe",
      reason: "r1",
    });
    await post("/v1/followups", {
      personId: a.body.id,
      direction: "they_owe",
      reason: "r2",
    });
    const r = await get("/v1/followups?direction=i_owe");
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].direction).toBe("i_owe");
  });

  it("DELETE tombstones", async () => {
    const a = await post("/v1/people", { displayName: "A" });
    const f = await post("/v1/followups", {
      personId: a.body.id,
      direction: "i_owe",
      reason: "r",
    });
    const r = await del(`/v1/followups/${f.body.id}`);
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeTruthy();
  });
});

describe("manifest", () => {
  it("GET /v1/_manifest returns endpoints + JSON Schemas", async () => {
    const r = await get("/v1/_manifest");
    expect(r.status).toBe(200);
    expect(r.body.version).toBe("v1");
    const names = (r.body.endpoints as Array<{ name: string }>).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "find_people",
        "get_person",
        "add_person",
        "update_person",
        "tombstone_person",
        "get_interactions_for",
        "find_organizations",
        "list_interactions",
        "log_interaction",
        "list_followups",
        "create_followup",
        "update_followup",
      ]),
    );
    const addPerson = (
      r.body.endpoints as Array<{
        name: string;
        method: string;
        path: string;
        body?: unknown;
      }>
    ).find((e) => e.name === "add_person");
    expect(addPerson?.method).toBe("POST");
    expect(addPerson?.path).toBe("/v1/people");
    expect(addPerson?.body).toBeTruthy();
  });
});
