/**
 * Actions raised through a routine proposal / self-review bubble: a
 * `createRoutine` save, an `updateRoutinePrompt` refinement, or a
 * `disableRoutine` retirement. Single source of truth for the places that must
 * treat "a routine proposal" as one category:
 *  - the gated dispatcher records a durable decline on deny/cancel of any of them,
 *  - the prompt assembler exempts them from the "stale — consider cancelling" nudge.
 * (The one-pending proposal guard in `proposal-guard.ts` no longer consults
 * this set — it suppresses on ANY pending confirmation, proposal or not.)
 *
 * Lives in its own leaf module (one type-only import) so its consumers share it
 * without pulling the gated dispatcher's heavy service deps
 * (browser/gmail/kizuna) into one another's import graphs.
 */
export const ROUTINE_PROPOSAL_TOOLS = new Set<string>([
  "createRoutine",
  "updateRoutinePrompt",
  "disableRoutine",
]);
