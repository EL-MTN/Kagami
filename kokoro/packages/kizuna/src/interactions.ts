import { getJson, sendJson, appendParam, clampLimit, withKizunaDeadline } from "./client";
import { interactionSummary } from "./projections";
import {
  InteractionWireSchema,
  InteractionsEnvelopeSchema,
  type InteractionSummary,
  type ListEnvelope,
} from "./schemas";

export type InteractionParticipantInput = {
  personId: string;
  role: "from" | "to" | "cc" | "attendee" | "subject";
};

export type LogInteractionInput = {
  occurredAt: string;
  channel: "email" | "calendar" | "call" | "in_person" | "message" | "manual";
  title: string;
  body?: string;
  participants: InteractionParticipantInput[];
  context?: string[];
  location?: string;
};

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

export async function logInteraction(input: LogInteractionInput): Promise<InteractionSummary> {
  return withKizunaDeadline(async (signal) => {
    const body: Record<string, unknown> = {
      occurredAt: input.occurredAt,
      channel: input.channel,
      title: input.title,
      participants: input.participants,
    };
    if (input.body !== undefined) body.body = input.body;
    if (input.context !== undefined) body.context = input.context;
    if (input.location !== undefined) body.location = input.location;
    const wire = await sendJson(
      "POST",
      "/interactions",
      "/interactions",
      body,
      InteractionWireSchema,
      signal,
    );
    return interactionSummary(wire);
  });
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
