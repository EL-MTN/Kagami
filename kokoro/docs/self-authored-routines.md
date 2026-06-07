# Self-Authored Routines — Design & Implementation Plan

> **Status: IMPLEMENTED.** Kokoro can offer to save a just-completed task as a
> reusable routine via the `proposeRoutine` tool (always on, on live
> conversational turns; human-approved). The operational reference now lives in
> [`ai-layer.md`](ai-layer.md#proposeroutine-live-conversational-turns-only)
> (tool surface, guard, dispatch-only `createRoutine`) and
> [`confirmations.md`](confirmations.md#dispatch-only-actions-not-llm-raisable)
> (the rail + dispatch-only pattern). This document is retained as the design
> rationale (why Option A, alternatives rejected, safety analysis).
>
> **One deviation from the plan below:** `createRoutine` is **not** added to
> `GATED_TOOL_NAMES` (§Components & files step 5 / Testing). Doing so would put
> it in `requestConfirmation`'s enum and let the model raise it directly,
> bypassing the `proposeRoutine` guard. Instead it's a separate **dispatch-only**
> action (`DISPATCH_ONLY_TOOL_NAMES`) — dispatchable via the approval rail but
> absent from the LLM-wrappable enum. This keeps the existing
> `isGatedTool("createRoutine") === false` assertion true and better honors the
> "reachable only via the approval rail" invariant. The signature/origin
> discriminator for recording declines is `action.tool === "createRoutine"`.

## Motivation

Kokoro already has **routines** — saved, named, reusable prompt-procedures that
can be run on demand or on a cron (see [`watchers.md`](watchers.md) for the sibling
"detection" primitive, and `apps/bot/src/services/routine-executor.ts`). Today a
routine is created only when the user explicitly asks, via the `manageRoutines`
tool.

"Self-authored routines" closes the gap surfaced by comparing Kokoro to
self-improving agents (e.g. Nous Research's Hermes, which writes its own reusable
"skills" after solving a task): **the agent should be able to notice it just did a
reusable multi-step task and offer to save it** — human-approved, never
autonomous. It is the on-brand, confirmation-gated version of "skills that grow
with you."

## Chosen approach (Option A): inline proposal tool + durable decline memory

The main conversational model, on a natural closing turn, offers to save the task
by calling a new **`proposeRoutine`** tool. That tool runs a durable anti-nag
guard, then raises a tap-to-approve bubble by reusing the existing confirmation
rail. On approve, a gated **`createRoutine`** action creates the routine.

- **No separate per-turn LLM call** and **no new token category** — the proposal
  rides the turn the model already paid for.
- The only durable state added is a small **declines** record, so a "no" survives
  conversation-history truncation.

This is the purest "rely on the LLM" design (the conversational model decides
inline, no heuristic gate), plus the one piece the codebase makes non-optional:
durable memory of a decline.

### Alternatives considered (and why not)

Three reviewers (red-team, codebase-integration, architecture) evaluated the
design. Two alternatives were rejected:

- **A separate `generateObject` "reflection" call after every turn.** Rejected:
  it costs a cheap LLM call on _every_ message (incl. "ok"/"thanks"), drafts from
  a _truncated/secondhand_ summary rather than the live turn, and — being a second
  over-eager proposer — is _more_ prone to nagging, not less. The `stepCountIs(5)`
  budget already pushes the natural proposal moment to the closing turn, where the
  main model has ample budget and the real tool calls in context.
- **Dropping durable decline state entirely** (relying on the LLM seeing prior
  denials in conversation history). Rejected on hard evidence: `assembleMessages`
  loads only the last **40 messages** (`getRecentMessages(chatId, 40)`), and
  `getOrCreateSession` **closes the session after 1h idle and starts an empty
  history**. So a decline reliably scrolls out of context within hours; the LLM
  cannot remember a "no." The codebase already reached this conclusion elsewhere:
  watchers are LLM-driven yet enforce anti-over-notification with durable
  `cooldownMs` / `lastFiredAt` / `snoozedUntil` (`watcher-executor.ts`).

## End-to-end flow

```
normal turn → model judges "this was a reusable multi-step task"
  └─ calls proposeRoutine({ name, description, prompt, parameters? })
       1. signature = norm(name) + short hash(prompt)
       2. GUARD (code-side, durable):
            • isRecentlyDeclined(chatId, signature)?      → return "skip: declined recently"
            • any routine/skill proposal already pending?  → return "skip: one already pending"
       3. raisePendingConfirmation(chatId, adapter, {
            summary, origin: "routine",
            action: { tool: "createRoutine", args: { ...draft, signature } } })
          → posts the bubble showing the FULL routine prompt + "on-demand, read-only"
       4. return "awaiting approval" so the model stops

user taps ✓ Approve → existing callback (unchanged)
  └─ dispatchGatedAction("createRoutine", args)
       • re-validate args (Zod + validateCronAndDefaults)   ← authoritative server-side gate
       • createRoutine(chatId, { ...draft, purity: "read",
                                 cronSchedule: null, enabled: true })
       • recordProposalDecision(chatId, signature, "accepted")
       • duplicate name → graceful { success: false, summary: "already exists" }

user taps ✗ Deny / cancels
  └─ recordProposalDecision(chatId, signature, "declined")  (escalating cooldown)
```

## Components & files

### New

1. **`packages/db/src/models/routine-proposal.ts`** — `RoutineProposalDecision`
   model: `{ chatId, signature, verdict: "accepted" | "declined", denyCount,
lastDecidedAt, expiresAt (TTL) }`, index `(chatId, signature)`. Helpers
   `recordProposalDecision()` and `isRecentlyDeclined(chatId, signature)` with an
   escalating cooldown (first decline → quiet for `ROUTINE_PROPOSAL_COOLDOWN_DAYS`,
   repeat declines → longer). Export from `packages/db/src/index.ts`.
2. **`apps/bot/src/ai/tools/routine-proposals.ts`** — `createProposeRoutineTool(chatId, adapter)`:
   the model-facing (ungated) tool. Zod args `{ name, description, prompt,
parameters? }`; computes the signature; runs the guard; calls
   `raisePendingConfirmation`.
3. **`apps/bot/context/instructions/routine-proposals.md`** — the system-prompt
   rule (see below).

### Changed

4. **`apps/bot/src/ai/tools/confirmations.ts`** — **extract**
   `raisePendingConfirmation(chatId, adapter, { summary, action, origin, originRef })`
   from `requestConfirmation.execute` (the create → send →
   `if (messageId) setPromptMessageId(...)` sequence). `requestConfirmation` then
   calls it, so the rail has a single writer.
5. **`apps/bot/src/services/gated-actions.ts`** — add `"createRoutine"` to
   `GATED_TOOL_NAMES` + a `GATED_ARG_SCHEMAS` entry (reuse `parameterSchema` +
   `validateCronAndDefaults` from `tools/routines.ts`) + a dispatcher `case` that
   re-validates, calls `createRoutine(...)` with safe defaults, records `accepted`,
   and catches `isDuplicateKeyError`. `createRoutine` is **dispatch-only** — it is
   _not_ registered in `allTools`; the model reaches it only via the approval rail.
6. **`apps/bot/src/ai/tools/index.ts`** — register `proposeRoutine` in `allTools`
   **only** on live conversational turns (`ctx.conversational`); deliberately absent from
   `watcherTools` / `routineToolsUnderWatcher`, so watchers and scheduled routines
   can't self-author (preserves the read-only invariant).
7. **`apps/bot/src/platform/telegram/bot.ts`**, **`apps/bot/src/platform/imessage/webhook.ts`**,
   **`confirmations.ts`** (cancel path) — on **deny/cancel** of an `origin: "routine"`
   confirmation, call `recordProposalDecision(chatId, row.action.args.signature, "declined")`.
8. **`apps/bot/src/ai/context-assembler.ts`** — load `routine-proposals.md` into
   `assemblePromptShell` on conversational turns, and **exclude it from the no-tools
   acknowledgment turn** (same opt-out used for the MCP hint). Give proposal
   confirmations a **shorter TTL** than action confirmations and **skip them in the
   "stale — consider cancelling" nudge** so ignored proposals don't pollute the main
   prompt for 24h.
9. **`packages/shared/src/config.ts`** + **`apps/bot/.env.example`** +
   **`ARCHITECTURE.md`** — `ROUTINE_PROPOSAL_COOLDOWN_DAYS` (default `14`).
10. **`kokoro/docs/ai-layer.md`** (+ a note in `confirmations.md`) — document the
    proposal flow once implemented.

## System-prompt rule (`routine-proposals.md`)

> After you finish a **multi-step** task the user is likely to repeat, you may
> offer to save it as a routine by calling `proposeRoutine` — but only on a natural
> closing turn (never mid-task), **at most one at a time**, and only for genuinely
> reusable procedures (never trivial/one-off requests). Generalize the concrete run
> into a reusable `prompt` with `parameters` for the parts that varied. Default to
> **on-demand** (no schedule). If the user has declined a similar suggestion, don't
> raise it again.

## Safety (blast radius)

Routines can later call gated actions (`sendEmail`, `browseAgent`, …) and, if
cron'd, run autonomously — so self-authored ones are constrained:

- **No cron on proposed routines** → they never run autonomously; only when the
  user explicitly invokes them.
- **Full routine prompt shown on the approval bubble** (not just a one-line
  summary), labeled "on-demand, read-only," so the user reviews what they approve.
- Gated actions _inside_ a routine still raise their own confirmation at run time
  (existing property, preserved).
- `purity: "read"` default as defense-in-depth. _Note:_ purity gates
  watcher-invocation, **not** the main-run tool palette — the real guarantees are
  no-cron + run-time gating + full-prompt review.
- Server-side re-validation at approve time (`validateCronAndDefaults`, param
  types, name length) is the authoritative gate; never trust the draft args.

## Anti-nag

Durable `RoutineProposalDecision` keyed by `(chatId, signature)` because the LLM
cannot reliably see prior denials (40-message window + 1h session reset). The guard
runs in code before any bubble, so even an over-eager model is suppressed.
Combined with **one-pending-proposal suppression**, which also protects iMessage's
"exactly one pending" YES/NO resolver from stacked bubbles.

## Testing

- `routine-proposal` model (`withTestDb`): record/declined/accepted, cooldown +
  escalation, `(chatId, signature)` dedup, TTL.
- `gated-actions`: update the **pinned `GATED_TOOL_NAMES`** exact-match test; add a
  `createRoutine` dispatch test (creates routine; dup-name graceful; cron/param
  re-validation).
- `proposeRoutine` tool: guard suppresses when recently-declined / when a proposal
  is pending; otherwise raises the confirmation (mock `raisePendingConfirmation` +
  `fakeAdapter`).
- Deny path records a decline.
- Extend `tools/index.test.ts`: `proposeRoutine` present in the main palette,
  **absent** from watcher / under-watcher palettes.

## Build order

1. Extract `raisePendingConfirmation` + add the gated `createRoutine` action
   (self-contained, testable, useful on its own).
2. `RoutineProposalDecision` model + guard helpers.
3. `proposeRoutine` tool + `allTools` wiring + prompt rule + config flag.
4. Deny/cancel → record decline; proposal-confirmation TTL/nudge tweaks.
5. Docs + full test pass + `precheck`.

## Open calls (defaults chosen; flagged for awareness)

- **Signature** = normalized name + short prompt hash for v1; intent-level dedup
  (embeddings) is a future enhancement.
- **Cooldown** = 14 days, escalating on repeat declines.
- Proposed routines are **read / on-demand**; upgrading one to action/cron stays
  the explicit, user-driven `manageRoutines` path.
