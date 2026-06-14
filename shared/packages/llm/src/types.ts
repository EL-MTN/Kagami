import type { Logger } from "@kagami/logger";
import type { EmbeddingModel, LanguageModel } from "ai";

/** Native first-party SDK providers (hosted frontier models). */
export type NativeVendor = "anthropic" | "openai" | "xai" | "google";

interface ProviderConfigBase {
  /** Default model id, used by `model()` with no alias. */
  model: string;
  /**
   * Alias → model id for this provider, e.g. `{ fast: "...", smart: "..." }`.
   * `model("smart")` resolves here. A provider that lacks a requested alias is
   * skipped during fallback rather than silently downgraded.
   */
  models?: Record<string, string>;
  apiKey?: string;
  /** Per-call deadline in ms. Unset → no gateway-imposed timeout. */
  timeoutMs?: number;
}

/** `@ai-sdk/{anthropic,openai,xai,google}` — key/baseURL managed here. */
export interface NativeProviderConfig extends ProviderConfigBase {
  kind: "native";
  vendor: NativeVendor;
  /** Override the vendor's default API base (proxies, gateways). */
  baseURL?: string;
}

/** `@ai-sdk/openai-compatible` — LM Studio / local / OpenAI-shaped endpoints. */
export interface OpenAICompatibleProviderConfig extends ProviderConfigBase {
  kind: "openai-compatible";
  /** Required: the OpenAI-compatible endpoint, e.g. `http://localhost:1234/v1`. */
  baseURL: string;
  /** Provider label surfaced in logs/spans. Defaults to `"openai-compatible"`. */
  name?: string;
  /**
   * Send `response_format: { type: "json_schema" }` instead of `json_object`
   * (LM Studio rejects the latter). Defaults to `true`.
   */
  supportsStructuredOutputs?: boolean;
  /**
   * Promote stranded `reasoning_content` to a text part. Default-on for this
   * kind. Set `false` only for an endpoint that uses
   * `reasoning_content` semantically.
   */
  reasoningRepair?: boolean;
}

export type ProviderConfig = NativeProviderConfig | OpenAICompatibleProviderConfig;

export interface InferenceOptions {
  /** Caller service name — attributed onto every usage event. */
  service: string;
  /** The caller's `@kagami/logger` instance; spans/usage emit through it. */
  logger: Logger;
  /** Primary chat provider. */
  chat: ProviderConfig;
  /** Optional embedding provider (Kioku sets it; Kokoro does not). */
  embedding?: OpenAICompatibleProviderConfig;
  /** Ordered same-tier failover chain, tried after the primary's retries. */
  fallback?: ProviderConfig[];
  /**
   * Workspace-wide alias map applied when a provider does not define its own
   * `models`. Lets callers pass tiers once instead of per-provider.
   */
  models?: Record<string, string>;
  /** Retry tuning; sensible defaults applied when omitted. */
  retry?: RetryOptions;
}

export interface RetryOptions {
  /** Max attempts per provider before failover. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (full-jitter). Default 250. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxDelayMs?: number;
}

export interface Inference {
  /** Resolve a model by alias (`"fast"`, `"smart"`, …) or the default. */
  model(name?: string): LanguageModel;
  /** Text embedding model. Throws if no embedding provider was configured. */
  embeddings(): EmbeddingModel;
  /** Resolved primary provider id, for health/diagnostics. */
  readonly providerId: string;
}

/** Shape emitted on the observability seam per completed call. */
export interface UsageEvent {
  service: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  fallbackUsed: boolean;
  /** `"error"` when the call returned nothing: every attempt on every provider failed, or the caller aborted. */
  status: "ok" | "error";
  /** Total attempts across the whole call, including failovers. */
  attempts: number;
  /**
   * One compact label per failed attempt, e.g. `"TimeoutError@30.0s"` —
   * provider-prefixed (`"xai:http_429@1.2s"`) only when a fallback chain
   * makes the provider ambiguous.
   */
  attemptErrors?: string[];
  /**
   * Caller-supplied op label for this call (e.g. `"answer"`), recovered from
   * the `withCallOp` AsyncLocalStorage seam. Absent when the caller did not
   * wrap the generate call.
   */
  op?: string;
}
