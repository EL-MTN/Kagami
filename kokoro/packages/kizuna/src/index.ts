export { KIZUNA_TIMEOUT_MS, KizunaClientError } from "./client";
export { findPeople, getPerson, getPersonContext, updatePerson } from "./people";
export type { UpdatePersonInput } from "./people";
export { logInteraction, recentInteractions } from "./interactions";
export type { InteractionParticipantInput, LogInteractionInput } from "./interactions";
export { createFollowup, listFollowups, listMyFollowups, resolveFollowup } from "./followups";
export type { CreateFollowupInput, ResolveFollowupInput } from "./followups";
export type {
  FollowupSummary,
  FollowupWire,
  InteractionSummary,
  InteractionWire,
  ListEnvelope,
  PersonContext,
  PersonSummary,
  PersonWire,
} from "./schemas";
