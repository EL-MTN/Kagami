import { logger } from "@kokoro/shared";
import {
  KizunaClientError,
  getJson,
  sendJson,
  appendParam,
  clampLimit,
  withKizunaDeadline,
} from "./client";
import { getPersonWithSignal } from "./people";
import { followupSummary, missingPersonSummary, personSummary } from "./projections";
import {
  FollowupWireSchema,
  FollowupsEnvelopeSchema,
  type FollowupSummary,
  type FollowupWire,
  type ListEnvelope,
  type PersonSummary,
} from "./schemas";

export type ListFollowupsInput = {
  direction?: "i_owe" | "they_owe";
  status?: "open" | "done" | "snoozed" | "dismissed";
  limit?: number;
};

export type CreateFollowupInput = {
  personId: string;
  direction: "i_owe" | "they_owe";
  reason: string;
  dueAt?: string;
  sourceInteractionId?: string;
};

export type ResolveFollowupInput = {
  followupId: string;
  status: "open" | "done" | "snoozed" | "dismissed";
  dueAt?: string;
  reason?: string;
};

export async function listFollowups(
  input: ListFollowupsInput = {},
): Promise<ListEnvelope<FollowupWire>> {
  return withKizunaDeadline((signal) => listFollowupsWithSignal(input, signal));
}

export async function listMyFollowups(
  input: ListFollowupsInput = {},
): Promise<ListEnvelope<FollowupSummary>> {
  return withKizunaDeadline(async (signal) => {
    const followups = await listFollowupsWithSignal(input, signal);
    const people = await hydratePeopleForFollowups(followups.items, signal);
    return {
      items: followups.items.map((followup) =>
        followupSummary(followup, people.get(followup.personId)!),
      ),
      ...(followups.nextCursor ? { nextCursor: followups.nextCursor } : {}),
    };
  });
}

export async function createFollowup(input: CreateFollowupInput): Promise<FollowupSummary> {
  return withKizunaDeadline(async (signal) => {
    const body: Record<string, unknown> = {
      personId: input.personId,
      direction: input.direction,
      reason: input.reason,
    };
    if (input.dueAt !== undefined) body.dueAt = input.dueAt;
    if (input.sourceInteractionId !== undefined) {
      body.sourceInteractionId = input.sourceInteractionId;
    }
    const wire = await sendJson(
      "POST",
      "/followups",
      "/followups",
      body,
      FollowupWireSchema,
      signal,
    );
    const person = await hydratePersonForFollowup(wire, signal);
    return followupSummary(wire, person);
  });
}

export async function resolveFollowup(input: ResolveFollowupInput): Promise<FollowupSummary> {
  return withKizunaDeadline(async (signal) => {
    const body: Record<string, unknown> = { status: input.status };
    if (input.dueAt !== undefined) body.dueAt = input.dueAt;
    if (input.reason !== undefined) body.reason = input.reason;
    const wire = await sendJson(
      "PATCH",
      `/followups/${encodeURIComponent(input.followupId)}`,
      "/followups/:id",
      body,
      FollowupWireSchema,
      signal,
    );
    const person = await hydratePersonForFollowup(wire, signal);
    return followupSummary(wire, person);
  });
}

async function hydratePersonForFollowup(
  wire: FollowupWire,
  signal: AbortSignal,
): Promise<PersonSummary> {
  try {
    const person = await getPersonWithSignal(wire.personId, signal);
    return personSummary(person);
  } catch (err) {
    if (err instanceof KizunaClientError && err.status === 404) {
      logger.warn(
        { kind: err.kind, routeTemplate: err.routeTemplate, status: err.status },
        "kizuna followup person missing",
      );
      return missingPersonSummary(wire.personId);
    }
    throw err;
  }
}

export async function listFollowupsForPerson(
  personId: string,
  input: Omit<ListFollowupsInput, "direction">,
  signal: AbortSignal,
): Promise<ListEnvelope<FollowupWire>> {
  const params = listFollowupsParams(input);
  params.set("personId", personId);
  return getJson(`/followups?${params.toString()}`, "/followups", FollowupsEnvelopeSchema, signal);
}

async function listFollowupsWithSignal(
  input: ListFollowupsInput,
  signal: AbortSignal,
): Promise<ListEnvelope<FollowupWire>> {
  return getJson(buildListFollowupsPath(input), "/followups", FollowupsEnvelopeSchema, signal);
}

function listFollowupsParams(input: ListFollowupsInput) {
  const params = new URLSearchParams();
  appendParam(params, "direction", input.direction);
  params.set("status", input.status ?? "open");
  params.set("limit", String(clampLimit(input.limit, 50, 1, 50)));
  params.set("sort", "duePriority:1");
  return params;
}

export function buildListFollowupsPath(input: ListFollowupsInput = {}) {
  return `/followups?${listFollowupsParams(input).toString()}`;
}

async function hydratePeopleForFollowups(followups: FollowupWire[], signal: AbortSignal) {
  const uniqueIds = [...new Set(followups.map((followup) => followup.personId))];
  const entries = await mapLimit(
    uniqueIds,
    5,
    async (personId): Promise<[string, PersonSummary]> => {
      try {
        const person = await getPersonWithSignal(personId, signal);
        return [personId, personSummary(person)];
      } catch (err) {
        if (err instanceof KizunaClientError && err.status === 404) {
          logger.warn(
            { kind: err.kind, routeTemplate: err.routeTemplate, status: err.status },
            "kizuna followup person missing",
          );
          return [personId, missingPersonSummary(personId)];
        }
        throw err;
      }
    },
  );
  return new Map(entries);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
