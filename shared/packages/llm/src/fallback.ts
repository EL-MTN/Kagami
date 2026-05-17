import { performance } from "node:perf_hooks";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { Logger } from "@kagami/logger";
import { emitUsage } from "./observability.js";

/** A resolved, retry-wrapped model plus its labels for spans. */
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

/**
 * Same-tier failover composite (SPEC.md §6). `leaves` is the ordered chain for
 * a single resolved alias — every entry serves the *same* tier; a provider that
 * could not resolve the alias was dropped upstream, never downgraded. Each leaf
 * has already exhausted its own retries before it throws here, so this only
 * advances on terminal failure. Generate emits full token usage; a stream can
 * only fail over on the handshake (a started stream cannot be replayed) and its
 * span is emitted with zero token counts — stream token tap is deferred.
 */
export function composeFallback(
  leaves: Leaf[],
  ctx: { logger: Logger; service: string },
): LanguageModelV3 {
  const first = leaves[0];
  if (!first) throw new Error("@kagami/llm: no provider could serve the requested model");

  async function run<T>(
    op: (m: LanguageModelV3) => PromiseLike<T>,
    countTokens: boolean,
  ): Promise<T> {
    const started = performance.now();
    let lastErr: unknown;
    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      // Guarded for consumers compiled with `noUncheckedIndexedAccess`
      // (e.g. @kioku/api) — internal packages export raw .ts, so the
      // strictest consumer's tsconfig type-checks this source.
      if (!leaf) continue;
      try {
        const result = await op(leaf.model);
        const t = countTokens ? tokens(result) : { prompt: 0, completion: 0 };
        emitUsage(ctx.logger, {
          service: ctx.service,
          provider: leaf.provider,
          model: leaf.modelId,
          promptTokens: t.prompt,
          completionTokens: t.completion,
          durationMs: performance.now() - started,
          fallbackUsed: i > 0,
        });
        return result;
      } catch (err) {
        lastErr = err;
        const next = leaves[i + 1];
        if (next) {
          ctx.logger.warn({ error: err, from: leaf.provider, to: next.provider }, "llm.fallback");
        }
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
    doGenerate: (options: LanguageModelV3CallOptions) => run((m) => m.doGenerate(options), true),
    doStream: (options: LanguageModelV3CallOptions) => run((m) => m.doStream(options), false),
  };
}
