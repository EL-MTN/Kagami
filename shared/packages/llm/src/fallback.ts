import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { APICallError } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger } from "@kagami/logger";
import { getActiveCallOp } from "./context.js";
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

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Retryable iff the SDK flags it, the status is transient, or it timed out. */
export function isRetryable(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return (
      err.isRetryable || (err.statusCode !== undefined && RETRYABLE_STATUS.has(err.statusCode))
    );
  }
  // The per-attempt deadline (timeoutMiddleware's AbortSignal.timeout)
  // surfaces as TimeoutError.
  return err instanceof Error && err.name === "TimeoutError";
}

/** Compact per-attempt failure label, e.g. `"http_429"` or `"TimeoutError"`. */
function errorLabel(err: unknown): string {
  if (APICallError.isInstance(err) && err.statusCode !== undefined) {
    return `http_${err.statusCode}`;
  }
  return err instanceof Error ? err.name : "Error";
}

/** An abort-shaped rejection, as opposed to a provider failure that merely
 *  raced the caller's abort — the latter keeps its own label. */
function isAbortShaped(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError" || err.name === "ResponseAborted")
  );
}

/** Elapsed time at 0.1s precision — attempt histories must stay compact
 *  enough to survive the Kansoku CLI's 240-char fields display cap. */
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Same-tier failover composite — the single seam where retry, failover, and
 * span emission meet. `leaves` is the ordered chain for a single resolved
 * alias: every entry serves the *same* tier; a provider that could not
 * resolve the alias was dropped upstream, never downgraded.
 *
 * Every invocation emits exactly one `llm.generate` span carrying its full
 * attempt history — including invocations whose every attempt failed, which
 * previously vanished without a span. Each leaf gets up to
 * `retry.maxAttempts` attempts with full-jitter backoff; a non-retryable
 * failure ends the leaf's attempts and advances the chain. Once the
 * *caller's* signal aborts — mid-backoff included — retry and failover stop;
 * a leaf's per-attempt deadline (timeoutMiddleware) leaves that signal
 * untouched, which is how the two timeouts are told apart. Note that the AI
 * SDK's own `maxRetries` (default 2) sits above this composite and re-invokes
 * it on retryable terminal errors; each re-entry is its own span. Generate
 * emits full token usage; a stream retries/fails over only on the handshake
 * (a started stream cannot be replayed) and its span carries zero token
 * counts — stream token tap is deferred.
 */
export function composeFallback(
  leaves: Leaf[],
  ctx: { logger: Logger; service: string; retry?: RetryOptions },
): LanguageModelV3 {
  // Compact once so the loops below can never see a hole — per-iteration
  // `continue` guards would skew span emission if a hole ever appeared. This
  // is also where the noUncheckedIndexedAccess concession lives (consumers
  // type-check this source under @kioku/api's stricter tsconfig).
  const chain = leaves.filter((l): l is Leaf => l !== undefined);
  const first = chain[0];
  if (!first) throw new Error("@kagami/llm: no provider could serve the requested model");

  const maxAttempts = Math.max(1, ctx.retry?.maxAttempts ?? 3);
  const base = ctx.retry?.baseDelayMs ?? 250;
  const cap = ctx.retry?.maxDelayMs ?? 8_000;
  // Attempt labels carry their provider only when there is more than one —
  // on a single-provider chain the span's own `llm.provider` already says it,
  // and the prefix would eat into the CLI's fields cap.
  const prefixed = chain.length > 1;

  async function run<T>(
    op: (m: LanguageModelV3) => PromiseLike<T>,
    countTokens: boolean,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> {
    const started = performance.now();
    const attemptErrors: string[] = [];
    let attempts = 0;
    let lastErr: unknown;

    const emitSpan = (leaf: Leaf, fallbackUsed: boolean, status: "ok" | "error", result?: T) => {
      const t = status === "ok" && countTokens ? tokens(result) : { prompt: 0, completion: 0 };
      emitUsage(ctx.logger, {
        service: ctx.service,
        provider: leaf.provider,
        model: leaf.modelId,
        promptTokens: t.prompt,
        completionTokens: t.completion,
        durationMs: performance.now() - started,
        fallbackUsed,
        status,
        attempts,
        attemptErrors,
        op: getActiveCallOp(),
      });
    };

    // Terminal failure: one span, then reject. Every losing path exits here
    // so the failure span can never be emitted twice or with divergent shape.
    const fail = (leaf: Leaf, fallbackUsed: boolean, err: unknown): never => {
      emitSpan(leaf, fallbackUsed, "error");
      throw err;
    };

    for (const [i, leaf] of chain.entries()) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (callerSignal?.aborted) fail(leaf, i > 0, callerSignal.reason ?? lastErr);
        const attemptStarted = performance.now();
        attempts += 1;
        try {
          const result = await op(leaf.model);
          emitSpan(leaf, i > 0, "ok", result);
          return result;
        } catch (err) {
          lastErr = err;
          const aborted = callerSignal?.aborted === true;
          // A genuine provider failure that raced the abort keeps its own
          // label; only abort-shaped rejections are attributed to the caller.
          const label = aborted && isAbortShaped(err) ? "aborted" : errorLabel(err);
          const elapsed = secs(performance.now() - attemptStarted);
          attemptErrors.push(`${prefixed ? `${leaf.provider}:` : ""}${label}@${elapsed}`);
          if (aborted) fail(leaf, i > 0, err);
          if (attempt === maxAttempts - 1 || !isRetryable(err)) break;
          const backoffMs = Math.round(Math.random() * Math.min(cap, base * 2 ** attempt));
          // Compact `cause` only — the raw error's enumerable fields include
          // the full request body, which must not ship on every retry line.
          ctx.logger.warn(
            {
              provider: leaf.provider,
              model: leaf.modelId,
              attempt: attempt + 1,
              max_attempts: maxAttempts,
              backoff_ms: backoffMs,
              cause: label,
            },
            "llm.retry",
          );
          try {
            await sleep(backoffMs, undefined, { signal: callerSignal });
          } catch {
            // Caller aborted mid-backoff — no further attempt is launched.
            fail(leaf, i > 0, callerSignal?.reason ?? err);
          }
        }
      }
      const next = chain[i + 1];
      if (next) {
        ctx.logger.warn(
          { from: leaf.provider, to: next.provider, cause: errorLabel(lastErr) },
          "llm.fallback",
        );
      } else {
        fail(leaf, i > 0, lastErr);
      }
    }
    // Unreachable: the last leaf always returns or exits via fail().
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
