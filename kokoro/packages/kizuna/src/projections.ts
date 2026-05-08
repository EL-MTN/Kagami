import type {
  FollowupSummary,
  FollowupWire,
  InteractionSummary,
  InteractionWire,
  PersonContextSummary,
  PersonSummary,
  PersonWire,
} from "./schemas";

export const EXCERPT_MAX_CHARS = 600;

export function excerpt(value: string | null | undefined, maxChars = EXCERPT_MAX_CHARS) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return { excerpt: null, truncated: false };
  return {
    excerpt: normalized.slice(0, maxChars),
    truncated: normalized.length > maxChars,
  };
}

export function personSummary(person: PersonWire): PersonSummary {
  return {
    id: person.id,
    displayName: person.displayName,
    primaryEmail: person.primaryEmail,
    primaryOrgId: person.primaryOrgId,
    tags: person.tags,
    lastInteractionAt: person.lastInteractionAt,
  };
}

export function personContextSummary(person: PersonWire): PersonContextSummary {
  const relationship = excerpt(person.relationship);
  const notes = excerpt(person.notes);
  return {
    ...personSummary(person),
    relationshipExcerpt: relationship.excerpt,
    relationshipTruncated: relationship.truncated,
    emails: person.emails,
    phones: person.phones,
    handles: person.handles,
    birthday: person.birthday,
    notesExcerpt: notes.excerpt,
    notesTruncated: notes.truncated,
  };
}

export function interactionSummary(interaction: InteractionWire): InteractionSummary {
  const body = excerpt(interaction.body);
  return {
    id: interaction.id,
    occurredAt: interaction.occurredAt,
    channel: interaction.channel,
    title: interaction.title,
    bodyExcerpt: body.excerpt,
    bodyTruncated: body.truncated,
    participants: interaction.participants,
    context: interaction.context,
    status: interaction.status,
  };
}

export function followupSummary(followup: FollowupWire, person: PersonSummary): FollowupSummary {
  const reason = excerpt(followup.reason);
  return {
    id: followup.id,
    person,
    direction: followup.direction,
    dueAt: followup.dueAt,
    status: followup.status,
    reasonExcerpt: reason.excerpt ?? "",
    reasonTruncated: reason.truncated,
    sourceInteractionId: followup.sourceInteractionId,
  };
}

export function missingPersonSummary(personId: string): PersonSummary {
  return {
    id: personId,
    displayName: "Unknown person",
    primaryEmail: null,
    primaryOrgId: null,
    tags: [],
    lastInteractionAt: null,
  };
}
