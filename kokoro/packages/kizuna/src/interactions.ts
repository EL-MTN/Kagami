import { getJson, appendParam, clampLimit, withKizunaDeadline } from "./client";
import { interactionSummary } from "./projections";
import { InteractionsEnvelopeSchema, type InteractionSummary, type ListEnvelope } from "./schemas";

export type RecentInteractionsInput = {
  personId: string;
  channel?: "email" | "calendar" | "call" | "in_person" | "message" | "manual";
  since?: string;
  limit?: number;
};

export async function recentInteractions(
  input: RecentInteractionsInput,
): Promise<ListEnvelope<InteractionSummary>> {
  return withKizunaDeadline((signal) => recentInteractionsWithSignal(input, signal));
}

export async function recentInteractionsWithSignal(
  input: RecentInteractionsInput,
  signal: AbortSignal,
): Promise<ListEnvelope<InteractionSummary>> {
  const result = await getJson(
    buildRecentInteractionsPath(input),
    "/interactions",
    InteractionsEnvelopeSchema,
    signal,
  );
  return {
    items: result.items.map(interactionSummary),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listInteractionsForPerson(
  personId: string,
  input: { limit?: number },
  signal: AbortSignal,
): Promise<ListEnvelope<InteractionSummary>> {
  const params = new URLSearchParams();
  params.set("limit", String(clampLimit(input.limit, 10, 1, 50)));
  params.set("sort", "occurredAt:-1");
  const result = await getJson(
    `/people/${encodeURIComponent(personId)}/interactions?${params.toString()}`,
    "/people/:id/interactions",
    InteractionsEnvelopeSchema,
    signal,
  );
  return {
    items: result.items.map(interactionSummary),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export function buildRecentInteractionsPath(input: RecentInteractionsInput) {
  const params = new URLSearchParams();
  params.set("personId", input.personId);
  appendParam(params, "channel", input.channel);
  appendParam(params, "occurredAfter", input.since);
  params.set("limit", String(clampLimit(input.limit, 20, 1, 50)));
  params.set("sort", "occurredAt:-1");
  return `/interactions?${params.toString()}`;
}
