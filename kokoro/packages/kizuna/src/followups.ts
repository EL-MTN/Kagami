import { logger } from "@kokoro/shared";
import { KizunaClientError, getJson, appendParam, clampLimit, withKizunaDeadline } from "./client";
import { getPersonWithSignal } from "./people";
import { followupSummary, missingPersonSummary, personSummary } from "./projections";
import {
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

export async function listFollowupsForPerson(
  personId: string,
  input: Omit<ListFollowupsInput, "direction">,
  signal: AbortSignal,
): Promise<ListEnvelope<FollowupWire>> {
  const params = listFollowupsParams(input);
  params.set("personId", personId);
  return getJson(
    `/v1/followups?${params.toString()}`,
    "/v1/followups",
    FollowupsEnvelopeSchema,
    signal,
  );
}

async function listFollowupsWithSignal(
  input: ListFollowupsInput,
  signal: AbortSignal,
): Promise<ListEnvelope<FollowupWire>> {
  return getJson(buildListFollowupsPath(input), "/v1/followups", FollowupsEnvelopeSchema, signal);
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
  return `/v1/followups?${listFollowupsParams(input).toString()}`;
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
