import { getJson, sendJson, appendParam, clampLimit, withKizunaDeadline } from "./client";
import { listFollowupsForPerson } from "./followups";
import { listInteractionsForPerson } from "./interactions";
import { personContextSummary, personSummary, followupSummary } from "./projections";
import {
  PeopleEnvelopeSchema,
  PersonWireSchema,
  type ListEnvelope,
  type PersonContext,
  type PersonSummary,
  type PersonWire,
} from "./schemas";

export type UpdatePersonInput = {
  personId: string;
  displayName?: string;
  primaryEmail?: string;
  primaryOrgId?: string;
  relationship?: string;
  emails?: string[];
  phones?: string[];
  handles?: Record<string, string>;
  tags?: string[];
  birthday?: string;
  notes?: string;
};

export async function findPeople(input: {
  query: string;
  limit?: number;
}): Promise<ListEnvelope<PersonSummary>> {
  return withKizunaDeadline((signal) => findPeopleWithSignal(input, signal));
}

export async function getPerson(personId: string): Promise<PersonWire> {
  return withKizunaDeadline((signal) => getPersonWithSignal(personId, signal));
}

export async function getPersonContext(input: { personId: string }): Promise<PersonContext> {
  return withKizunaDeadline(async (signal) => {
    const [person, interactions, followups] = await Promise.all([
      getPersonWithSignal(input.personId, signal),
      listInteractionsForPerson(input.personId, { limit: 10 }, signal),
      listFollowupsForPerson(input.personId, { status: "open", limit: 50 }, signal),
    ]);

    const compactPerson = personContextSummary(person);
    return {
      person: compactPerson,
      recentInteractions: interactions.items,
      openFollowups: followups.items.map((followup) =>
        followupSummary(followup, personSummary(person)),
      ),
      pagination: {
        recentInteractions: { truncated: Boolean(interactions.nextCursor) },
        openFollowups: { truncated: Boolean(followups.nextCursor) },
      },
      lastInteractionAt: compactPerson.lastInteractionAt,
    };
  });
}

export async function updatePerson(input: UpdatePersonInput): Promise<PersonSummary> {
  return withKizunaDeadline(async (signal) => {
    const { personId, ...rest } = input;
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) body[key] = value;
    }
    const wire = await sendJson(
      "PATCH",
      `/people/${encodeURIComponent(personId)}`,
      "/people/:id",
      body,
      PersonWireSchema,
      signal,
    );
    return personSummary(wire);
  });
}

async function findPeopleWithSignal(
  input: { query: string; limit?: number },
  signal: AbortSignal,
): Promise<ListEnvelope<PersonSummary>> {
  const params = new URLSearchParams();
  params.set("identityQuery", input.query);
  params.set("limit", String(clampLimit(input.limit, 10, 1, 20)));
  const result = await getJson(
    `/people?${params.toString()}`,
    "/people",
    PeopleEnvelopeSchema,
    signal,
  );
  return {
    items: result.items.map(personSummary),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function getPersonWithSignal(
  personId: string,
  signal: AbortSignal,
): Promise<PersonWire> {
  return getJson(
    `/people/${encodeURIComponent(personId)}`,
    "/people/:id",
    PersonWireSchema,
    signal,
  );
}

export function buildPeopleSearchPath(input: { query: string; limit?: number }) {
  const params = new URLSearchParams();
  appendParam(params, "identityQuery", input.query);
  params.set("limit", String(clampLimit(input.limit, 10, 1, 20)));
  return `/people?${params.toString()}`;
}
