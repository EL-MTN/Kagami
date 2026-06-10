import { z } from "zod";
import { defineEnv, kansokuShipper, logging, type EnvOutput } from "@kagami/env";

/**
 * Kioku API env spec — the single source of truth for this app's
 * configuration. `.env.example`, the docs/configuration.md table, and
 * turbo.json env declarations are all generated from it: edit here, then
 * `npm run env:gen`.
 *
 * This module must stay a leaf (zod + @kagami/env only) so the workspace
 * generator can import it without booting the app.
 *
 * Policy mix mirrors the pre-migration behavior: tuning knobs are
 * warn-default (an operator typo never crashes the memory service), while a
 * mis-set *_KIND or BM25/rate-limit override still fails loudly at boot.
 * Two knobs (the BM25 sigmoid overrides and the ingest rate limits) are
 * declared here for generation but resolved at runtime by their own modules
 * (`retrieval/scoring.ts`, `routes/rate-limit.ts`), which carry the
 * calibration constants and DI-testable parsers.
 */

// Kioku is openai-compatible only — reject a mis-set *_KIND loudly rather
// than silently ignoring it.
const openAiCompatibleKind = z
  .string()
  .refine((kind) => kind === "openai-compatible", "unsupported in Kioku — only 'openai-compatible'")
  .optional();

/**
 * BM25 sigmoid overrides — five query-length buckets, midpoint + steepness
 * each. Declared for generation; the runtime reader is
 * `retrieval/scoring.ts#loadBm25ParamsFromEnv`, which owns the calibrated
 * per-bucket defaults (hence no schema defaults here) and throws on an
 * invalid override.
 */
const bm25Midpoint = z.coerce.number().finite().nonnegative().optional();
const bm25Steepness = z.coerce.number().finite().positive().optional();
const bm25Doc = (kind: "midpoint" | "steepness", bucket: string) =>
  `Optional ${kind} override for the ${bucket}-term query-length bucket of\nthe BM25 sigmoid normalizer. Defaults are the calibrated constants in\nretrieval/scoring.ts — refit via scripts/probe-bm25-scores.ts (see\ndocs/retrieval.md and docs/bench.md).`;
const BM25_GROUP = "BM25 sigmoid tuning";

const kansoku = kansokuShipper();
const log = logging();

export const envSpec = defineEnv({
  service: "kioku",
  component: "api",
  // LLM_MODEL is canonical. MODEL is the longmemeval bench's answerer-model
  // variable — the bench reuses the answerer through query/answer.ts (see
  // apps/api/scripts/longmemeval*.ts), setting MODEL rather than LLM_MODEL.
  aliases: { MODEL: "LLM_MODEL" },
  vars: {
    KIOKU_HOST: z.string().default("127.0.0.1").meta({
      doc: "Standalone fallback bind host. Under `portless run`, PORT is injected\nautomatically and https://api.kioku.localhost is proxied; these only\nmatter running standalone (e.g. `tsx src/server.ts`).",
      standaloneOnly: true,
      group: "Standalone fallback",
    }),
    PORT: z.coerce.number().int().positive().max(65_535).default(7777).meta({
      doc: "Standalone fallback bind port (Portless injects its own otherwise).",
      standaloneOnly: true,
      group: "Standalone fallback",
      onInvalid: "warn-default",
    }),

    ...log.vars,
    ...kansoku.vars,

    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must be a mongodb:// URI")
      .default("mongodb://127.0.0.1:27017/kioku?directConnection=true")
      .meta({
        doc: 'Connection URI for the storage layer. Include the DB name in the path —\nmongo.ts reads it from there (and falls back to "kioku" if the URI\'s\ndefault DB is "test"). Defaults to a local atlas-local replica set on\n127.0.0.1:27017 ($vectorSearch/$search need atlas-local, not vanilla\nMongo). Boot it with:\n  atlas local start mongodb\n(or `docker run -p 27017:27017 mongodb/mongodb-atlas-local`).\nThe vector index dim is probed from the embedding provider at startup.\nA malformed URI fails boot — only an UNSET value uses the local default\n(a data pointer must never silently redirect to a different database).',
        crossService: true,
        group: "MongoDB",
      }),

    KIOKU_TOP_K: z.coerce.number().int().positive().default(50).meta({
      doc: "Number of candidate facts the answerer pulls per query before ranking.",
      onInvalid: "warn-default",
      group: "Retrieval",
    }),

    KIOKU_BULK_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10).meta({
      doc: "Per-IP cap on POST /facts/bulk (embedding-heavy ingest), over a\none-minute window. Resolved at boot by routes/rate-limit.ts (throws on a\nnon-positive-integer override).",
      group: "Ingest rate limits",
    }),
    KIOKU_SESSION_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5).meta({
      doc: "Per-IP cap on POST /sessions, over a one-minute window. Resolved at boot\nby routes/rate-limit.ts (throws on a non-positive-integer override).",
      group: "Ingest rate limits",
    }),

    BM25_SIGMOID_MIDPOINT_3: bm25Midpoint.meta({
      doc: bm25Doc("midpoint", "≤3"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_STEEPNESS_3: bm25Steepness.meta({
      doc: bm25Doc("steepness", "≤3"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_MIDPOINT_6: bm25Midpoint.meta({
      doc: bm25Doc("midpoint", "≤6"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_STEEPNESS_6: bm25Steepness.meta({
      doc: bm25Doc("steepness", "≤6"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_MIDPOINT_9: bm25Midpoint.meta({
      doc: bm25Doc("midpoint", "≤9"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_STEEPNESS_9: bm25Steepness.meta({
      doc: bm25Doc("steepness", "≤9"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_MIDPOINT_15: bm25Midpoint.meta({
      doc: bm25Doc("midpoint", "≤15"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_STEEPNESS_15: bm25Steepness.meta({
      doc: bm25Doc("steepness", "≤15"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_MIDPOINT_GT15: bm25Midpoint.meta({
      doc: bm25Doc("midpoint", ">15"),
      group: BM25_GROUP,
    }),
    BM25_SIGMOID_STEEPNESS_GT15: bm25Steepness.meta({
      doc: bm25Doc("steepness", ">15"),
      group: BM25_GROUP,
    }),

    LLM_KIND: openAiCompatibleKind.meta({
      doc: "Chat/answerer provider kind. Kioku goes through the @kagami/llm gateway\nand is openai-compatible only — the deployed default is OpenAI; LM Studio\n(local), vLLM, and Ollama are drop-in alternatives.",
      example: "openai-compatible",
      recommended: true,
      group: "LLM (chat / answerer)",
    }),
    LLM_BASE_URL: z.string().optional().meta({
      doc: "Chat endpoint base URL. Unset boots with a warning and fails at first\nrequest — set it (e.g. https://api.openai.com/v1, or\nhttp://localhost:1234/v1 for LM Studio).",
      example: "https://api.openai.com/v1",
      recommended: true,
      group: "LLM (chat / answerer)",
    }),
    LLM_API_KEY: z.string().optional().meta({
      doc: "Chat endpoint API key (any non-empty string works for local servers like\nLM Studio).",
      secret: true,
      recommended: true,
      group: "LLM (chat / answerer)",
    }),
    LLM_MODEL: z.string().optional().meta({
      doc: "Chat model id, provider-native — gpt-4o-mini, or whatever your local\nserver exposes. Unset boots with a warning.",
      example: "gpt-4o-mini",
      recommended: true,
      group: "LLM (chat / answerer)",
    }),
    LLM_TIMEOUT_MS: z.coerce
      .number()
      .finite()
      .positive()
      .max(2_147_483_647, "exceeds Node's timer ceiling")
      .optional()
      .meta({
        doc: 'Optional per-attempt gateway deadline in milliseconds. Must be a positive\nfinite number within Node\'s timer ceiling (2147483647); anything else is\nignored with a warn — an out-of-range value would otherwise make\nAbortSignal.timeout() throw on every call. Coerced with Number(), not\nparseInt, so suffixed junk like "180s" is rejected rather than\npartial-parsed.',
        onInvalid: "warn-default",
        group: "LLM (chat / answerer)",
      }),

    EMBEDDING_KIND: openAiCompatibleKind.meta({
      doc: "Embedding provider kind — openai-compatible only, same as LLM_KIND.\nChat and embedding endpoints are independent; set each separately.",
      example: "openai-compatible",
      recommended: true,
      group: "Embeddings",
    }),
    EMBEDDING_BASE_URL: z.string().optional().meta({
      doc: "Embedding endpoint base URL. Unset boots with a warning and fails at\nfirst request.",
      example: "https://api.openai.com/v1",
      recommended: true,
      group: "Embeddings",
    }),
    EMBEDDING_API_KEY: z.string().optional().meta({
      doc: "Embedding endpoint API key.",
      secret: true,
      recommended: true,
      group: "Embeddings",
    }),
    EMBEDDING_MODEL: z.string().default("text-embedding-3-small").meta({
      doc: "Embedding model id. The deployed default is OpenAI\ntext-embedding-3-small (1536-dim); the vector-index dim is probed from\nthe provider at startup, so a model swap requires dropping the vector\nindexes and re-ingesting (see docs/configuration.md).",
      group: "Embeddings",
    }),
  },
});

export type Config = EnvOutput<typeof envSpec>;
