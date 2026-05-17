import { newTraceContext, runWithTrace } from "@kagami/logger";
import type { Logger } from "@kagami/logger";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { APICallError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInference } from "../src";
import { composeFallback, type Leaf } from "../src/fallback";
import { isRetryable, reasoningRepairMiddleware, retryMiddleware } from "../src/middleware";
import { emitUsage } from "../src/observability";
import { providerLabel, resolveModelId } from "../src/provider";
import type { InferenceOptions, OpenAICompatibleProviderConfig } from "../src/types";

// --- typed fixtures -------------------------------------------------------

const usage = (input: number, output: number): LanguageModelV3Usage => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

const genResult = (
  content: LanguageModelV3Content[],
  u: LanguageModelV3Usage = usage(11, 22),
): LanguageModelV3GenerateResult => ({
  content,
  finishReason: { unified: "stop", raw: "stop" },
  usage: u,
  warnings: [],
});

function fakeModel(gen: () => Promise<LanguageModelV3GenerateResult>): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: gen,
    doStream: () => Promise.reject(new Error("doStream not exercised")),
  };
}

const leaf = (
  provider: string,
  modelId: string,
  gen: () => Promise<LanguageModelV3GenerateResult>,
): Leaf => ({ model: fakeModel(gen), provider, modelId });

/** A real logger with info/warn spied — fully typed, no `any`. */
function spyLogger(): {
  logger: Logger;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const warn = vi.fn();
  const logger = { info, warn } as unknown as Logger;
  return { logger, info, warn };
}

const wrapArg = (gen: () => Promise<LanguageModelV3GenerateResult>) => ({
  doGenerate: gen,
  doStream: () => Promise.reject(new Error("n/a")),
  params: {} as unknown as LanguageModelV3CallOptions,
  model: fakeModel(gen),
});

const apiErr = (status: number, retryable: boolean): APICallError =>
  new APICallError({
    message: `status ${status}`,
    url: "http://x",
    requestBodyValues: {},
    statusCode: status,
    isRetryable: retryable,
  });

// --- resolveModelId -------------------------------------------------------

describe("resolveModelId", () => {
  const cfg: OpenAICompatibleProviderConfig = {
    kind: "openai-compatible",
    baseURL: "http://lm",
    model: "default-m",
    models: { smart: "smart-m" },
  };

  it("returns the default model when no alias is given", () => {
    expect(resolveModelId(cfg, undefined, undefined)).toBe("default-m");
  });

  it("resolves a provider-local alias", () => {
    expect(resolveModelId(cfg, "smart", undefined)).toBe("smart-m");
  });

  it("falls back to the shared alias map", () => {
    expect(resolveModelId(cfg, "fast", { fast: "shared-fast" })).toBe("shared-fast");
  });

  it("returns undefined when an alias is unresolvable (caller decides skip vs throw)", () => {
    expect(resolveModelId(cfg, "missing", undefined)).toBeUndefined();
  });

  it("prefers the provider-local alias over the shared map", () => {
    expect(resolveModelId(cfg, "smart", { smart: "shared-smart" })).toBe("smart-m");
  });
});

describe("providerLabel", () => {
  it("labels native by vendor and openai-compatible by name", () => {
    expect(providerLabel({ kind: "native", vendor: "anthropic", model: "m" })).toBe("anthropic");
    expect(
      providerLabel({ kind: "openai-compatible", baseURL: "u", model: "m", name: "lmstudio" }),
    ).toBe("lmstudio");
  });
});

// --- isRetryable ----------------------------------------------------------

describe("isRetryable", () => {
  it("trusts the SDK retryable flag", () => {
    expect(isRetryable(apiErr(400, true))).toBe(true);
  });
  it("treats transient statuses as retryable even if unflagged", () => {
    expect(isRetryable(apiErr(429, false))).toBe(true);
    expect(isRetryable(apiErr(503, false))).toBe(true);
  });
  it("does not retry non-transient 4xx", () => {
    expect(isRetryable(apiErr(400, false))).toBe(false);
    expect(isRetryable(apiErr(404, false))).toBe(false);
  });
  it("retries provider-imposed timeouts", () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    expect(isRetryable(e)).toBe(true);
  });
  it("does not retry arbitrary errors", () => {
    expect(isRetryable(new Error("boom"))).toBe(false);
  });
});

// --- reasoning-repair middleware -----------------------------------------

describe("reasoningRepairMiddleware", () => {
  const wg = reasoningRepairMiddleware.wrapGenerate;
  if (!wg) throw new Error("wrapGenerate must be defined");

  it("passes through when a non-empty text part exists", async () => {
    const out = await wg(wrapArg(() => Promise.resolve(genResult([{ type: "text", text: "hi" }]))));
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("promotes stranded reasoning to a text part", async () => {
    const out = await wg(
      wrapArg(() => Promise.resolve(genResult([{ type: "reasoning", text: '{"ok":true}' }]))),
    );
    expect(out.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  it("preserves tool-call parts while repairing", async () => {
    const tool: LanguageModelV3Content = {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "do",
      input: "{}",
    };
    const out = await wg(
      wrapArg(() => Promise.resolve(genResult([tool, { type: "reasoning", text: "R" }]))),
    );
    expect(out.content).toContainEqual(tool);
    expect(out.content).toContainEqual({ type: "text", text: "R" });
  });

  it("does not invent text when there is no reasoning either", async () => {
    const empty = genResult([]);
    const out = await wg(wrapArg(() => Promise.resolve(empty)));
    expect(out.content).toEqual([]);
  });
});

// --- retry middleware -----------------------------------------------------

describe("retryMiddleware", () => {
  it("retries a retryable failure then succeeds", async () => {
    const wg = retryMiddleware({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }).wrapGenerate;
    if (!wg) throw new Error("wrapGenerate must be defined");
    let n = 0;
    const out = await wg(
      wrapArg(() => {
        n += 1;
        if (n < 3) return Promise.reject(apiErr(503, true));
        return Promise.resolve(genResult([{ type: "text", text: "ok" }]));
      }),
    );
    expect(n).toBe(3);
    expect(out.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("gives up immediately on a non-retryable failure", async () => {
    const wg = retryMiddleware({ maxAttempts: 5, baseDelayMs: 1 }).wrapGenerate;
    if (!wg) throw new Error("wrapGenerate must be defined");
    let n = 0;
    await expect(
      wg(
        wrapArg(() => {
          n += 1;
          return Promise.reject(apiErr(400, false));
        }),
      ),
    ).rejects.toThrow("status 400");
    expect(n).toBe(1);
  });

  it("stops after maxAttempts and rethrows the last error", async () => {
    const wg = retryMiddleware({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }).wrapGenerate;
    if (!wg) throw new Error("wrapGenerate must be defined");
    let n = 0;
    await expect(
      wg(
        wrapArg(() => {
          n += 1;
          return Promise.reject(apiErr(503, true));
        }),
      ),
    ).rejects.toThrow("status 503");
    expect(n).toBe(2);
  });
});

// --- observability seam ---------------------------------------------------

describe("emitUsage", () => {
  it("emits an event.kind:span line with llm fields and no trace outside a context", () => {
    const { logger, info } = spyLogger();
    emitUsage(logger, {
      service: "kioku",
      provider: "lmstudio",
      model: "m",
      promptTokens: 3,
      completionTokens: 4,
      durationMs: 12,
      fallbackUsed: false,
    });
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("llm.generate");
    expect(fields.event).toEqual({ kind: "span" });
    expect(fields.llm).toMatchObject({ service: "kioku", prompt_tokens: 3, fallback_used: false });
    expect(fields.trace).toBeUndefined();
  });

  it("attaches the active trace id when inside a trace context", () => {
    const { logger, info } = spyLogger();
    const ctx = newTraceContext({ sampled: true });
    runWithTrace(ctx, () =>
      emitUsage(logger, {
        service: "kokoro",
        provider: "anthropic",
        model: "m",
        promptTokens: 1,
        completionTokens: 1,
        durationMs: 1,
        fallbackUsed: true,
      }),
    );
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.trace).toEqual({ id: ctx.traceId });
  });
});

// --- composeFallback ------------------------------------------------------

describe("composeFallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when the chain is empty (no provider served the alias)", () => {
    const { logger } = spyLogger();
    expect(() => composeFallback([], { logger, service: "s" })).toThrow(/no provider/);
  });

  it("uses the primary and maps nested token usage; fallbackUsed=false", async () => {
    const { logger, info, warn } = spyLogger();
    const m = composeFallback(
      [
        leaf("anthropic", "claude", () =>
          Promise.resolve(genResult([{ type: "text", text: "y" }], usage(11, 22))),
        ),
      ],
      { logger, service: "kokoro" },
    );
    const res = await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(res.content).toEqual([{ type: "text", text: "y" }]);
    expect(warn).not.toHaveBeenCalled();
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.llm).toMatchObject({
      provider: "anthropic",
      model: "claude",
      prompt_tokens: 11,
      completion_tokens: 22,
      fallback_used: false,
    });
  });

  it("fails over same-tier to the next provider and flags fallbackUsed", async () => {
    const { logger, info, warn } = spyLogger();
    const m = composeFallback(
      [
        leaf("anthropic", "claude-smart", () => Promise.reject(apiErr(503, true))),
        leaf("xai", "grok-smart", () => Promise.resolve(genResult([{ type: "text", text: "z" }]))),
      ],
      { logger, service: "kokoro" },
    );
    const res = await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(res.content).toEqual([{ type: "text", text: "z" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnFields] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnFields).toMatchObject({ from: "anthropic", to: "xai" });
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.llm).toMatchObject({ provider: "xai", fallback_used: true });
  });

  it("throws the last error when every provider in the tier fails", async () => {
    const { logger } = spyLogger();
    const m = composeFallback(
      [
        leaf("a", "m1", () => Promise.reject(apiErr(500, true))),
        leaf("b", "m2", () => Promise.reject(new Error("final boom"))),
      ],
      { logger, service: "s" },
    );
    await expect(m.doGenerate({} as unknown as LanguageModelV3CallOptions)).rejects.toThrow(
      "final boom",
    );
  });
});

// --- createInference ------------------------------------------------------

describe("createInference", () => {
  const baseOpts = (): InferenceOptions => {
    const { logger } = spyLogger();
    return {
      service: "kokoro",
      logger,
      chat: {
        kind: "native",
        vendor: "anthropic",
        model: "claude-default",
        models: { smart: "claude-smart" },
      },
    };
  };

  it("exposes the primary provider id", () => {
    expect(createInference(baseOpts()).providerId).toBe("anthropic");
  });

  it("throws if embeddings() is called without an embedding provider", () => {
    expect(() => createInference(baseOpts()).embeddings()).toThrow(/no embedding provider/);
  });

  it("throws when the primary cannot serve a requested alias", () => {
    expect(() => createInference(baseOpts()).model("nonexistent")).toThrow(
      /has no model for alias/,
    );
  });

  it("builds a default model without touching the network", () => {
    const m = createInference(baseOpts()).model();
    expect((m as LanguageModelV3).specificationVersion).toBe("v3");
  });

  it("drops a fallback provider that cannot serve the tier (same-tier, never downgraded)", () => {
    const opts = baseOpts();
    opts.fallback = [
      // No `smart` alias and no default that matches — must be skipped, not throw.
      { kind: "openai-compatible", baseURL: "http://lm", model: "local-default" },
    ];
    // smart resolves on primary; fallback skipped; still a valid composite.
    const m = createInference(opts).model("smart");
    expect((m as LanguageModelV3).modelId).toBe("claude-smart");
  });
});
