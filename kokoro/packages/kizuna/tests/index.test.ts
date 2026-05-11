import { setupMswServer } from "@kokoro/test-utils";
import { config, logger } from "@kokoro/shared";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPeople, getPersonContext, listMyFollowups, recentInteractions } from "../src";

type ConfigWithKizuna = {
  KIZUNA_URL: string;
  KIZUNA_ENABLED: boolean;
};

const KIZUNA_BASE = "http://kizuna.test";
const server = setupMswServer();

let originalUrl: string;
let originalEnabled: boolean;

beforeAll(() => {
  originalUrl = config.KIZUNA_URL;
  originalEnabled = config.KIZUNA_ENABLED;
  (config as unknown as ConfigWithKizuna).KIZUNA_URL = KIZUNA_BASE;
  (config as unknown as ConfigWithKizuna).KIZUNA_ENABLED = true;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  (config as unknown as ConfigWithKizuna).KIZUNA_URL = originalUrl;
  (config as unknown as ConfigWithKizuna).KIZUNA_ENABLED = originalEnabled;
  vi.restoreAllMocks();
});

function person(overrides: Partial<WirePerson> = {}): WirePerson {
  return {
    id: "111111111111111111111111",
    displayName: "Sarah Chen",
    primaryEmail: "sarah@example.com",
    primaryOrgId: null,
    relationship: null,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastInteractionAt: "2026-03-01T00:00:00.000Z",
    emails: ["sarah@example.com"],
    phones: [],
    handles: { telegram: "@sarah" },
    tags: ["friend"],
    birthday: null,
    notes: null,
    suppressReingest: false,
    source: "concierge",
    sourceVersion: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function interaction(overrides: Partial<WireInteraction> = {}): WireInteraction {
  return {
    id: "222222222222222222222222",
    occurredAt: "2026-03-01T00:00:00.000Z",
    channel: "email",
    title: "Catch up",
    body: "Long body",
    sourceRef: { provider: "gmail", id: "gmail-secret" },
    participants: [{ personId: "111111111111111111111111", role: "from" }],
    location: null,
    attachments: [],
    context: [],
    status: "active",
    source: "gmail",
    sourceVersion: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function followup(overrides: Partial<WireFollowup> = {}): WireFollowup {
  return {
    id: "333333333333333333333333",
    personId: "111111111111111111111111",
    direction: "i_owe",
    dueAt: null,
    status: "open",
    reason: "Send the deck",
    sourceInteractionId: null,
    source: "concierge",
    sourceVersion: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type WirePerson = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryOrgId: string | null;
  relationship: string | null;
  firstSeen: string | null;
  lastInteractionAt: string | null;
  emails: string[];
  phones: string[];
  handles: Record<string, string>;
  tags: string[];
  birthday: string | null;
  notes: string | null;
  suppressReingest: boolean;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WireInteraction = {
  id: string;
  occurredAt: string;
  channel: "email" | "calendar" | "call" | "in_person" | "message" | "manual";
  title: string;
  body: string;
  sourceRef: { provider: "gmail" | "gcal"; id: string } | null;
  participants: Array<{ personId: string; role: "from" | "to" | "cc" | "attendee" | "subject" }>;
  location: string | null;
  attachments: Array<{
    name: string;
    mimeType: string | null;
    size: number | null;
    ref: string | null;
  }>;
  context: string[];
  status: "active" | "cancelled";
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type WireFollowup = {
  id: string;
  personId: string;
  direction: "i_owe" | "they_owe";
  dueAt: string | null;
  status: "open" | "done" | "snoozed" | "dismissed";
  reason: string;
  sourceInteractionId: string | null;
  source: string;
  sourceVersion: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

describe("findPeople", () => {
  it("uses identityQuery, clamps limit, sends no Authorization header, and projects summaries", async () => {
    let observedUrl = "";
    let authHeader: string | null = null;
    server.use(
      http.get(`${KIZUNA_BASE}/people`, ({ request }) => {
        observedUrl = request.url;
        authHeader = request.headers.get("authorization");
        return HttpResponse.json({
          items: [person({ relationship: "do not expose" })],
          nextCursor: "n",
        });
      }),
    );

    const result = await findPeople({ query: "Sarah Chen", limit: 99 });
    const url = new URL(observedUrl);

    expect(url.searchParams.get("identityQuery")).toBe("Sarah Chen");
    expect(url.searchParams.get("query")).toBeNull();
    expect(url.searchParams.get("limit")).toBe("20");
    expect(authHeader).toBeNull();
    expect(result.nextCursor).toBe("n");
    expect(result.items).toEqual([
      {
        id: "111111111111111111111111",
        displayName: "Sarah Chen",
        primaryEmail: "sarah@example.com",
        primaryOrgId: null,
        tags: ["friend"],
        lastInteractionAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });
});

describe("recentInteractions", () => {
  it("maps since to occurredAfter, sets occurredAt sort, clamps limits, and drops sourceRef", async () => {
    let observedUrl = "";
    server.use(
      http.get(`${KIZUNA_BASE}/interactions`, ({ request }) => {
        observedUrl = request.url;
        return HttpResponse.json({
          items: [interaction({ body: "hello\n\nworld" })],
        });
      }),
    );

    const result = await recentInteractions({
      personId: "111111111111111111111111",
      channel: "email",
      since: "2026-01-01T00:00:00.000Z",
      limit: 0,
    });
    const url = new URL(observedUrl);

    expect(url.searchParams.get("personId")).toBe("111111111111111111111111");
    expect(url.searchParams.get("channel")).toBe("email");
    expect(url.searchParams.get("occurredAfter")).toBe("2026-01-01T00:00:00.000Z");
    expect(url.searchParams.get("since")).toBeNull();
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("sort")).toBe("occurredAt:-1");
    expect(result.items[0]).toMatchObject({
      bodyExcerpt: "hello world",
      bodyTruncated: false,
    });
    expect(JSON.stringify(result.items)).not.toContain("gmail-secret");
  });
});

describe("getPersonContext", () => {
  it("fans out to the person, sorted interactions, and due-priority followups endpoints", async () => {
    const observed: string[] = [];
    server.use(
      http.get(`${KIZUNA_BASE}/people/111111111111111111111111`, ({ request }) => {
        observed.push(new URL(request.url).pathname);
        return HttpResponse.json(
          person({
            relationship: " close   friend ".repeat(80),
            notes: "met at conference\n\nlikes ramen",
          }),
        );
      }),
      http.get(`${KIZUNA_BASE}/people/111111111111111111111111/interactions`, ({ request }) => {
        observed.push(
          `${new URL(request.url).pathname}?${new URL(request.url).searchParams.toString()}`,
        );
        return HttpResponse.json({ items: [interaction()], nextCursor: "i-next" });
      }),
      http.get(`${KIZUNA_BASE}/followups`, ({ request }) => {
        observed.push(
          `${new URL(request.url).pathname}?${new URL(request.url).searchParams.toString()}`,
        );
        return HttpResponse.json({ items: [followup()], nextCursor: "f-next" });
      }),
    );

    const result = await getPersonContext({ personId: "111111111111111111111111" });

    expect(observed).toEqual(
      expect.arrayContaining([
        "/people/111111111111111111111111",
        "/people/111111111111111111111111/interactions?limit=10&sort=occurredAt%3A-1",
        "/followups?status=open&limit=50&sort=duePriority%3A1&personId=111111111111111111111111",
      ]),
    );
    expect(result.pagination).toEqual({
      recentInteractions: { truncated: true },
      openFollowups: { truncated: true },
    });
    expect(result.person.relationshipTruncated).toBe(true);
    expect(result.person.notesExcerpt).toBe("met at conference likes ramen");
  });
});

describe("listMyFollowups", () => {
  it("uses due-priority ordering, hydrates people once, and preserves followup order", async () => {
    const personIds = ["111111111111111111111111", "222222222222222222222222"];
    const hydrated: string[] = [];
    let listUrl = "";
    server.use(
      http.get(`${KIZUNA_BASE}/followups`, ({ request }) => {
        listUrl = request.url;
        return HttpResponse.json({
          items: [
            followup({ id: "333333333333333333333333", personId: personIds[0], reason: "first" }),
            followup({ id: "444444444444444444444444", personId: personIds[0], reason: "second" }),
            followup({ id: "555555555555555555555555", personId: personIds[1], reason: "third" }),
          ],
          nextCursor: "more",
        });
      }),
      http.get(`${KIZUNA_BASE}/people/:id`, ({ params }) => {
        const rawId: unknown = params.id;
        const id =
          Array.isArray(rawId) && typeof rawId[0] === "string"
            ? rawId[0]
            : typeof rawId === "string"
              ? rawId
              : "";
        hydrated.push(id);
        return HttpResponse.json(person({ id, displayName: `Person ${id}` }));
      }),
    );

    const result = await listMyFollowups({ direction: "i_owe", limit: 99 });
    const url = new URL(listUrl);

    expect(url.searchParams.get("direction")).toBe("i_owe");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("duePriority:1");
    expect(hydrated.sort()).toEqual(personIds.sort());
    expect(result.items.map((item) => item.reasonExcerpt)).toEqual(["first", "second", "third"]);
    expect(result.nextCursor).toBe("more");
  });

  it("uses an Unknown person placeholder for followup hydration 404s", async () => {
    server.use(
      http.get(`${KIZUNA_BASE}/followups`, () =>
        HttpResponse.json({ items: [followup({ personId: "999999999999999999999999" })] }),
      ),
      http.get(`${KIZUNA_BASE}/people/999999999999999999999999`, () =>
        HttpResponse.json({ error: { code: "not_found" } }, { status: 404 }),
      ),
    );

    const result = await listMyFollowups();

    expect(result.items[0]?.person).toEqual({
      id: "999999999999999999999999",
      displayName: "Unknown person",
      primaryEmail: null,
      primaryOrgId: null,
      tags: [],
      lastInteractionAt: null,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("error handling", () => {
  it("throws a disabled KizunaClientError when the integration is disabled", async () => {
    (config as unknown as ConfigWithKizuna).KIZUNA_ENABLED = false;
    try {
      await expect(findPeople({ query: "Sarah" })).rejects.toMatchObject({
        name: "KizunaClientError",
        kind: "disabled",
        message: "Kizuna integration disabled",
      });
    } finally {
      (config as unknown as ConfigWithKizuna).KIZUNA_ENABLED = true;
    }
  });

  it("classifies non-2xx and schema failures without leaking request details into safe messages", async () => {
    server.use(
      http.get(`${KIZUNA_BASE}/people`, () =>
        HttpResponse.json({ error: "rate limit for Sarah" }, { status: 429 }),
      ),
    );

    await expect(findPeople({ query: "Sarah Secret" })).rejects.toMatchObject({
      kind: "http",
      status: 429,
      routeTemplate: "/people",
      message: "Kizuna request failed with status 429",
    });

    server.use(http.get(`${KIZUNA_BASE}/people`, () => HttpResponse.json({ items: [{}] })));

    await expect(findPeople({ query: "Sarah Secret" })).rejects.toMatchObject({
      kind: "schema",
      routeTemplate: "/people",
      message: "Kizuna response schema mismatch",
    });
  });
});
