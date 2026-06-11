import { performance } from "node:perf_hooks";
import { APICallError } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger } from "@kagami/logger";
import { isRetryable } from "./middleware.js";
import { emitUsage } from "./observability.js";
import type { RetryOptions } from "./types.js";

/** A resolved, timeout-wrapped model plus its labels for spans. */
export interface Leaf {
  model: LanguageModelV3;
  provider: string;
  modelId: string;
}

/**
 * Pull token totals off a generate result. `LanguageModelV3Usage` nests counts
 * (`inputTokens.total`), and stream results carry no usage at handshake time —
 * both collapse to 0 here, which is why stream spans report zero tokens.
 */
function tokens(result: unknown): { prompt: number; completion: number } {
  const u = (result as { usage?: LanguageModelV3Usage }).usage;
  return { prompt: u?.inputTokens.total ?? 0, completion: u?.outputTokens.total ?? 0 };
}

/** Compact per-attempt failure label, e.g. `"http_429"` or `"TimeoutError"`. */
function errorLabel(err: unknown): string {
  if (APICallError.isInstance(err) && err.statusCode !== undefined) {
    return `http_${err.statusCode}`;
  }
  return err instanceof Error ? err.name : "Error";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Same-tier failover composite, and the home of the retry loop. `leaves` is
 * the ordered chain for a single resolved alias — every entry serves the
 * *same* tier; a provider that could not resolve the alias was dropped
 * upstream, never downgraded.
 *
 * Retry and failover live here, around the span seam, so every call emits one
 * `llm.generate` span carrying its full attempt history — including calls
 * whose every attempt failed, which previously vanished without a span. Each
 * leaf gets up to `retry.maxAttempts` attempts with full-jitter backoff
 * (`delay = random(0, min(cap, base * 2^attempt))` — implemented here, not
 * imported: `@kagami/logger`'s jitter is private to its Kansoku shipper);
 * a non-retryable failure ends the leaf's attempts and advances the chain.
 * Once the *caller's* signal has aborted, both retry and failover stop —
 * a leaf's own per-attempt deadline (timeoutMiddleware) leaves that signal
 * untouched, which is how the two timeouts are told apart. Generate emits
 * full token usage; a stream retries/fails over only on the handshake (a
 * started stream cannot be replayed) and its span carries zero token counts —
 * stream token tap is deferred.
 */
export function composeFallback(
  leaves: Leaf[],
  ctx: { logger: Logger; service: string; retry?: RetryOptions },
): LanguageModelV3 {
  const first = leaves[0];
  if (!first) throw new Error("@kagami/llm: no provider could serve the requested model");

  const maxAttempts = ctx.retry?.maxAttempts ?? 3;
  const base = ctx.retry?.baseDelayMs ?? 250;
  const cap = ctx.retry?.maxDelayMs ?? 8_000;

  async function run<T>(
    op: (m: LanguageModelV3) => PromiseLike<T>,
    countTokens: boolean,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> {
    const started = performance.now();
    const attemptErrors: string[] = [];
    let attempts = 0;
    let lastErr: unknown;

    const emit = (leaf: Leaf, fallbackUsed: boolean, result?: T): void => {
      const t = result !== undefined && countTokens ? tokens(result) : { prompt: 0, completion: 0 };
      emitUsage(ctx.logger, {
        service: ctx.service,
        provider: leaf.provider,
        model: leaf.modelId,
        promptTokens: t.prompt,
        completionTokens: t.completion,
        durationMs: performance.now() - started,
        fallbackUsed,
        status: result !== undefined ? "ok" : "error",
        attempts,
        attemptErrors,
      });
    };

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      // Guarded for consumers compiled with `noUncheckedIndexedAccess`
      // (e.g. @kioku/api) — internal packages export raw .ts, so the
      // strictest consumer's tsconfig type-checks this source.
      if (!leaf) continue;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const attemptStarted = performance.now();
        attempts += 1;
        try {
          const result = await op(leaf.model);
          emit(leaf, i > 0, result);
          return result;
        } catch (err) {
          lastErr = err;
          const aborted = callerSignal?.aborted === true;
          const elapsed = Math.round(performance.now() - attemptStarted);
          attemptErrors.push(
            `${leaf.provider}:${aborted ? "aborted" : errorLabel(err)}@${elapsed}ms`,
          );
          if (aborted) {
            emit(leaf, i > 0);
            throw err;
          }
          if (attempt === maxAttempts - 1 || !isRetryable(err)) break;
          const backoffMs = Math.round(Math.random() * Math.min(cap, base * 2 ** attempt));
          ctx.logger.warn(
            {
              error: err,
              provider: leaf.provider,
              model: leaf.modelId,
              attempt: attempt + 1,
              max_attempts: maxAttempts,
              backoff_ms: backoffMs,
            },
            "llm.retry",
          );
          await sleep(backoffMs);
        }
      }
      const next = leaves[i + 1];
      if (next) {
        ctx.logger.warn({ error: lastErr, from: leaf.provider, to: next.provider }, "llm.fallback");
      } else {
        emit(leaf, i > 0);
      }
    }
    throw lastErr;
  }

  return {
    specificationVersion: "v3",
    get provider() {
      return first.provider;
    },
    get modelId() {
      return first.modelId;
    },
    get supportedUrls() {
      return first.model.supportedUrls;
    },
    doGenerate: (options: LanguageModelV3CallOptions) =>
      run((m) => m.doGenerate(options), true, options.abortSignal),
    doStream: (options: LanguageModelV3CallOptions) =>
      run((m) => m.doStream(options), false, options.abortSignal),
  };
}
