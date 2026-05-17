# `@kagami/llm` — Inference Gateway (Spec)

Status: **Draft / not implemented.** This specs the _capability_; see §1 for why it is a
package, not a service, and the exact condition that would change that.

---

## 1. Form decision (read this first)

The inference gateway ships as a **workspace package, `@kagami/llm`**, in the same
tier as `@kagami/logger`. It is **not** a standalone service today.

This is deliberate and follows the workspace's own rule: _new shared concern →
default to a package; promote to a service only when it needs its own runtime
lifecycle, its own datastore boundary, or an external consumer._ An LLM client —
even one with retry, fallback, and key management — is shared library code. None
of the three promotion criteria are met yet:

- **Runtime lifecycle** — no shared mutable state crosses processes. Retry,
  fallback, and circuit-breaking are per-process and correct as in-process logic.
- **Datastore boundary** — token/cost accounting writes to each caller's existing
  Mongo (Kokoro already has a `TokenUsage` model). The gateway does not own data.
- **External consumer** — only Kioku and Kokoro call models. Both are in this repo.

**The single promotion trigger.** Extract `@kagami/llm` into a service the moment
you need **cross-process coordination of provider rate limits or spend caps** —
i.e. when two services sharing one provider key must not collectively exceed a
TPM/RPM ceiling or a daily budget, and per-process limiters cannot enforce that.
That is real shared runtime state with its own lifecycle, and it is the _only_
thing here that a package structurally cannot do. Until that day arrives with a
concrete number attached, a service is premature and reintroduces exactly the
distributed-monolith risk the workspace is otherwise free of.

Everything below specs the package. §10 specs the service it becomes _if and only
if_ the trigger fires, so the boundary is designed in from day one.

---

## 2. Problem

LLM access is implemented twice, divergently:

|                         | Kokoro `apps/bot/src/ai/provider.ts`             | Kioku `apps/api/src/llm.ts`                                        |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Abstraction             | native `@ai-sdk/{anthropic,openai,xai,google}`   | `@ai-sdk/openai-compatible`                                        |
| `LLM_PROVIDER` values   | `anthropic` \| `xai` \| `openai`                 | `lmstudio` \| `openai`                                             |
| Endpoint override       | none (SDK-managed)                               | `LLM_URL` / `LLM_API_KEY` + profiles                               |
| Model selection         | `ModelTier` (Default/Fast/Smart) + `TIER_MODELS` | single `MODEL` env                                                 |
| Embeddings              | none (delegated to Kioku, `ARCHITECTURE.md:193`) | `EMBEDDING_*`, separate endpoint                                   |
| Provider quirks handled | —                                                | `reasoning_content` repair middleware, `supportsStructuredOutputs` |
| Image generation        | `getImageModel`, `provider/model` spec           | —                                                                  |

Consequences: the `LLM_*` env namespace means **incompatible things** in the two
services; provider keys, retry, timeout, and cost accounting are each solved zero
or one times instead of once; there is no shared place for fallback, rate-limit
backpressure, or per-call cost attribution; and adding a provider is a two-site
edit with two different mental models.

## 3. Goals

- One provider/credential/retry/fallback surface, consumed by Kokoro and Kioku.
- Preserve **both** existing capability sets: hosted-frontier + tiering (Kokoro)
  **and** OpenAI-compatible/local + embeddings + reasoning-repair (Kioku).
- Trace-correlated, cost-attributed calls by construction (every call emits a
  `@kagami/logger` span and a token-usage record keyed by trace + caller).
- Adding/repointing a provider is a one-file change in `@kagami/llm`.
- Zero behavior change for callers at cutover (adapters, then call-site swap).

## 4. Non-goals

- **Not** a prompt/agent framework. No prompt templates, no context assembly, no
  tool orchestration — that stays in Kokoro (the orchestrator; see memory
  `feedback_kokoro_orchestrator`).
- **Not** owning model _policy_. Which tier a Kokoro routine uses, which model
  Kioku extraction runs — caller-owned. The gateway resolves and executes; it
  does not decide intent.
- **Not** a network hop in this revision. In-process only (see §1).
- **Not** image or speech. `getImageModel`, TTS, and STT stay in Kokoro for now;
  the API leaves room (§5) but they are out of scope until a second caller needs
  them.

## 5. Package API

`@kagami/llm`, raw-`.ts`-source internal package (`exports: "./src/index.ts"`),
mirroring `@kagami/logger`'s shape and depending on it for spans.

```ts
// Construction — once per process, from the caller's validated config.
createInference(opts: {
  service: string;                 // "kokoro" | "kioku" — for cost attribution + logs
  chat: ProviderConfig;            // provider, model(s), key, baseURL?, timeoutMs?
  embedding?: ProviderConfig;      // optional; Kioku sets it, Kokoro does not
  fallback?: ProviderConfig[];     // ordered; same-tier failover (see §6)
  models?: Record<string, string>; // named aliases, e.g. { fast: "...", smart: "..." }
}): Inference;

interface Inference {
  // Returns a Vercel AI SDK LanguageModel — callers keep using generateText/generateObject.
  model(name?: string): LanguageModel;        // name ∈ models keys; default = chat.model
  embeddings(): EmbeddingModel;               // throws if no embedding config
  readonly providerId: string;                // resolved provider, for logs/health
}
```

Design notes:

- **Returns AI SDK model objects, not a bespoke `generate()`.** Both call sites
  already use `generateText`/`generateObject` from `ai`. Wrapping those would
  force a migration of every call site's options surface for no gain. The gateway
  owns _construction_ (provider, key, retry/fallback middleware, span+cost
  middleware via `wrapLanguageModel`); callers keep owning _invocation_.
- **Named models, not a hardcoded `ModelTier` enum.** Kokoro's
  Default/Fast/Smart becomes `models: { fast, smart }` config; `model("fast")`
  replaces `getModel(ModelTier.Fast)`. Kioku passes no `models` and calls
  `model()`. Tier _policy_ (which alias for which task) stays in Kokoro.
- **`ProviderConfig` is the one provider abstraction.** It carries an explicit
  `kind: "native" | "openai-compatible"` so the gateway can construct either an
  `@ai-sdk/<vendor>` provider (Kokoro's hosted path) or
  `createOpenAICompatible` (Kioku's local/LM-Studio path) behind one type. This
  is the crux of the consolidation — both existing abstractions survive as two
  internal constructors selected by `kind`, not as two packages.
- **Reasoning-repair and `supportsStructuredOutputs` move into the
  openai-compatible constructor** so Kioku loses no behavior (the
  `reasoning_content → text` middleware from `kioku/apps/api/src/llm.ts` becomes
  default-on for `kind: "openai-compatible"`).

## 6. Cross-cutting behavior (centralized here)

Applied via `wrapLanguageModel` middleware so it is uniform across callers:

- **Span + cost**: every call goes through the internal observability seam
  (`src/observability.ts`). On this base (`origin/main`) the seam opens a child
  span via `@kagami/logger`'s present primitives (`getTraceContext` + `childSpan`
  - `generateSpanId`), times it with `performance.now()`, and emits one
    ECS-consistent `event.kind:"span"` line through the **caller's** logger with
    `{ service, trace.id, span.id, model, provider, promptTokens,
completionTokens, duration_ms, fallbackUsed }`. When `logging-prod-hardening`
    merges `runWithSpan`, only the seam's internals change — the package API and
    every caller stay byte-identical. The gateway only _emits_; persisting usage
    (Kokoro's `TokenUsage`, a Kioku equivalent) stays caller-side — it owns no
    datastore (see §1).
- **Retry**: bounded full-jitter backoff on 429/5xx/timeout only, implemented
  **locally** in `@kagami/llm`. (`@kagami/logger`'s jitter is internal to its
  Kansoku shipper and not exported — an earlier draft's "reuse" claim was wrong;
  the algorithm is ~10 lines and is reproduced, not imported.)
- **Fallback**: **same-tier**. A failed `model("smart")` fails over to the next
  `fallback[]` provider's _smart_ model — never down a tier to Default. The
  requested alias is preserved across the chain; each fallback provider must
  resolve the same alias or it is skipped. Tried only after the primary's retries
  are exhausted; fallback use is logged at `warn` with the originating trace and
  surfaced as `fallbackUsed:true` on the usage event.
- **Timeout**: per-call deadline from `timeoutMs` (Kokoro currently has none;
  Kioku has `LLM_TIMEOUT_MS`). Unified, with Kioku's value as the default.
- **Rate limiting**: a per-process limiter is in scope. **Cross-process** limiting
  is explicitly _not_ — that is the §10 promotion trigger, not a package feature.

## 7. Env consolidation

The namespace collision (§2) is resolved by **versioned, kind-explicit keys**
owned by `@kagami/llm` and validated in each service's existing Zod config:

```
LLM_KIND=native|openai-compatible
LLM_PROVIDER=anthropic|openai|xai|google     # when kind=native
LLM_BASE_URL= LLM_API_KEY= LLM_TIMEOUT_MS=    # when kind=openai-compatible
LLM_MODEL=  LLM_MODEL_FAST=  LLM_MODEL_SMART=  # aliases (fast/smart optional)
EMBEDDING_KIND= EMBEDDING_BASE_URL= EMBEDDING_API_KEY= EMBEDDING_MODEL=
```

Old keys are read with a deprecation `warn` for one release, then removed. Kioku's
bare `MODEL` → `LLM_MODEL`; Kokoro's implicit native keys → `LLM_KIND=native`.
`.env.example` in both services updated in the same commit as the cutover.

## 8. What deliberately does **not** move

Over-centralizing is how a clean package becomes the thing it warned about.
Staying caller-side: prompt/context assembly, tool definitions, the `ModelTier`
_policy_ (the mapping of task→alias), image generation, TTS/STT, and the decision
of _when_ to call a model at all. The gateway is a resolved, instrumented model
factory — nothing more.

## 9. Migration

Producer-before-consumer, single PR per service, no behavior change at cutover:

1. **Land `@kagami/llm`** with both provider kinds + middleware + tests
   (provider matrix, retry/fallback, span+usage emission, reasoning-repair parity
   against a recorded Kioku fixture).
2. **Kioku** (`apps/api/src/llm.ts`): replace internals with
   `createInference({ kind: "openai-compatible", embedding, ... })`; keep
   `llmEndpoint` export shape; verify recall/extraction integration tests green.
3. **Kokoro** (`apps/bot/src/ai/provider.ts`): `getModel(tier)` →
   `inference.model(tierAlias)`, `getModelName` derived from config. Image path
   untouched. Swap the ~7 call sites (`ai/generate.ts`, `ai/acknowledge.ts`,
   `context/generator.ts`, `scheduler/proactive.ts`,
   `services/{watcher,routine}-executor.ts`) mechanically.
4. **Delete** old env keys + dead provider code; update both `docs/` and
   `ARCHITECTURE.md:193` (embeddings note) + the config cheat sheet.

Each step is independently revertable; Kioku and Kokoro never need to cut over in
the same commit because the gateway is a library, not a contract between them.

## 10. If the promotion trigger fires (service spec, dormant)

_Only_ build this when §1's trigger is real with a number. Then `@kagami/llm`
gains a thin server (`kami/`? — its own `apps/api`, no dashboard, no Mongo): a
single in-memory token-bucket coordinator that the package's limiter consults
over a localhost call, fail-open (lose the call → fall back to the per-process
limiter, never block inference). The package API in §5 does **not** change —
callers never learn it became a hop. This is the whole reason the gateway is a
construction-time factory and not a `generate()` proxy: the seam is pre-cut, so
promotion is additive, not a rewrite.

## 11. Resolved decisions

1. **Kokoro fallback is same-tier** (not per-tier chains down to Default). The
   requested alias is preserved across the fallback chain; see §6. `fallback[]`
   is therefore alias-aware, not global.
2. **Kioku reasoning-repair is default-on for `kind: "openai-compatible"`** — no
   opt-in flag. Rationale: Kioku targets LM Studio, where thinking-mode models
   routinely strand structured output in `reasoning_content`; the repair is the
   common case there, not the exception. (Accepted risk: a spec-compliant
   endpoint that uses `reasoning_content` differently — none in use today; revisit
   only if a real such endpoint is introduced.)
3. **Usage = standardized event, not standardized storage.** The gateway emits a
   uniform usage event (§6); each caller persists it into its own schema. This
   preserves the no-datastore-boundary property from §1 and keeps the package
   service-promotion-ready without owning data.

## 12. Build base (this revision)

Built on `origin/main`, on branch `inference-gateway` (the worktree was retired —
a nested git worktree can't resolve a _new_ `@kagami/*` workspace package without
a shared-root install, so the cutover moved to a normal feature branch in the
main checkout). Mergeable to `main` independently — not stacked on
`logging-prod-hardening`. Observability rides the seam in §6: correct on main
today, swaps to `runWithSpan` with zero API change once the logging branch lands.
No dependency on unmerged work.

## 13. Implementation status (this branch)

- **Done:** `@kagami/llm` package (provider kinds, retry, same-tier fallback,
  per-attempt timeout, reasoning-repair, observability seam) + 29 unit tests.
  Kioku cutover (`apps/api/src/llm.ts`, public exports preserved, 60 tests
  green). Kokoro cutover (`apps/bot/src/ai/provider.ts` kept as the caller-side
  tier adapter — zero call-site changes — 238 bot tests green). Cross-cutting
  docs (`ARCHITECTURE.md`, workspace `CLAUDE.md`).
- **Deliberately deferred — §7 env-key versioning.** The cutover is
  behavior-preserving: Kioku still reads `LLM_*`/`EMBEDDING_*` via its existing
  `resolveEndpoint`; Kokoro still reads `config.LLM_PROVIDER`/`LLM_MODEL`. The
  `LLM_KIND`-style versioned keys + deprecation-warn shim + `.env.example`
  rewrite change the config contract and warrant their own change with a
  deprecation window — not smuggled into a behavior-preserving cutover. The
  per-project docs (`kioku/docs/configuration.md`, `kokoro/docs/ai-layer.md`)
  still describe the pre-gateway wiring and are part of that same follow-up.
