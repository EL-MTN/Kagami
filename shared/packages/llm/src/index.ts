import { wrapLanguageModel } from "ai";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import { composeFallback, type Leaf } from "./fallback.js";
import { retryMiddleware, timeoutMiddleware } from "./middleware.js";
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

/** Wrap one resolved provider+model with timeout (inner) then retry (outer). */
function leafFor(cfg: ProviderConfig, modelId: string, opts: InferenceOptions): Leaf {
  const stack: LanguageModelV3Middleware[] = [retryMiddleware(opts.retry)];
  if (cfg.timeoutMs !== undefined) stack.push(timeoutMiddleware(cfg.timeoutMs));
  return {
    model: wrapLanguageModel({ model: buildLeaf(cfg, modelId), middleware: stack }),
    provider: providerLabel(cfg),
    modelId,
  };
}

/**
 * Construct the inference gateway for a service (SPEC.md §5). Returns AI SDK
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
        // dropped, never downgraded (SPEC.md §6 — same-tier failover).
        const id = cfg === opts.chat ? primaryId : resolveModelId(cfg, name, opts.models);
        if (id === undefined) continue;
        leaves.push(leafFor(cfg, id, opts));
      }

      return composeFallback(leaves, {
        logger: opts.logger,
        service: opts.service,
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
