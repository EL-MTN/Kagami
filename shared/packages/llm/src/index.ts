import { wrapLanguageModel } from "ai";
import type { EmbeddingModel, LanguageModel } from "ai";
import { composeFallback, type Leaf } from "./fallback.js";
import { timeoutMiddleware } from "./middleware.js";
import { buildEmbedding, buildLeaf, providerLabel, resolveModelId } from "./provider.js";
import type { Inference, InferenceOptions, ProviderConfig } from "./types.js";

export type {
  Inference,
  InferenceOptions,
  NativeProviderConfig,
  NativeVendor,
  OpenAICompatibleProviderConfig,
  ProviderConfig,
  RetryOptions,
  UsageEvent,
} from "./types.js";

/**
 * Wrap one resolved provider+model with its per-attempt timeout. Retry and
 * failover live in `composeFallback` (one seam for attempts, failover, and
 * span emission); its loop re-invokes this wrapped model per attempt, which
 * is what makes the deadline per-attempt.
 */
function leafFor(cfg: ProviderConfig, modelId: string): Leaf {
  const bare = buildLeaf(cfg, modelId);
  return {
    model:
      cfg.timeoutMs !== undefined
        ? wrapLanguageModel({ model: bare, middleware: timeoutMiddleware(cfg.timeoutMs) })
        : bare,
    provider: providerLabel(cfg),
    modelId,
  };
}

/**
 * Construct the inference gateway for a service. Returns AI SDK
 * model objects — callers keep using `generateText`/`generateObject`/`embed`;
 * this owns construction (provider, keys, retry, same-tier fallback, timeout,
 * span+usage), not invocation.
 */
export function createInference(opts: InferenceOptions): Inference {
  const chain: ProviderConfig[] = [opts.chat, ...(opts.fallback ?? [])];

  return {
    providerId: providerLabel(opts.chat),

    model(name?: string): LanguageModel {
      const primaryId = resolveModelId(opts.chat, name, opts.models);
      if (primaryId === undefined) {
        throw new Error(
          `@kagami/llm: primary provider "${providerLabel(opts.chat)}" has no model ` +
            `for alias "${String(name)}" — define it in chat.models or opts.models`,
        );
      }

      const leaves: Leaf[] = [];
      for (const cfg of chain) {
        // Primary is guaranteed; a fallback that can't serve this tier is
        // dropped, never downgraded (same-tier failover).
        const id = cfg === opts.chat ? primaryId : resolveModelId(cfg, name, opts.models);
        if (id === undefined) continue;
        leaves.push(leafFor(cfg, id));
      }

      return composeFallback(leaves, {
        logger: opts.logger,
        service: opts.service,
        ...(opts.retry ? { retry: opts.retry } : {}),
      });
    },

    embeddings(): EmbeddingModel {
      if (!opts.embedding) {
        throw new Error(
          "@kagami/llm: embeddings() called but no embedding provider was configured",
        );
      }
      return buildEmbedding(opts.embedding);
    },
  };
}
