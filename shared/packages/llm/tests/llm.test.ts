import { newTraceContext, runWithTrace } from "@kagami/logger";
import type { Logger } from "@kagami/logger";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { APICallError, wrapLanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInference } from "../src";
import { composeFallback, isRetryable, type Leaf } from "../src/fallback";
import { reasoningRepairMiddleware, timeoutMiddleware } from "../src/middleware";
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

type StreamHandshake = Awaited<ReturnType<LanguageModelV3["doStream"]>>;

function fakeModel(
  gen: () => Promise<LanguageModelV3GenerateResult>,
  stream?: () => Promise<StreamHandshake>,
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-model",
    supportedUrls: {},
    doGenerate: gen,
    doStream: stream ?? (() => Promise.reject(new Error("doStream not exercised"))),
  };
}

const leaf = (
  provider: string,
  modelId: string,
  gen: () => Promise<LanguageModelV3GenerateResult>,
  stream?: () => Promise<StreamHandshake>,
): Leaf => ({ model: fakeModel(gen, stream), provider, modelId });

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

// --- retry loop (inside composeFallback) -----------------------------------

describe("composeFallback retry", () => {
  const fastRetry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

  it("retries a retryable failure then succeeds, recording attempts on the span", async () => {
    const { logger, info, warn } = spyLogger();
    let n = 0;
    const m = composeFallback(
      [
        leaf("xai", "grok", () => {
          n += 1;
          if (n < 3) return Promise.reject(apiErr(503, true));
          return Promise.resolve(genResult([{ type: "text", text: "ok" }]));
        }),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    const res = await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(n).toBe(3);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toBe("llm.retry");
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      provider: "xai",
      attempt: 1,
      max_attempts: 3,
      cause: "http_503",
    });
    // Compact cause only — the raw error (with its request body) must not
    // ride every retry line.
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("error");
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "ok" });
    expect(fields.llm).toMatchObject({
      attempts: 3,
      // Single-provider chain → labels carry no provider prefix.
      attempt_errors: [
        expect.stringMatching(/^http_503@\d+\.\ds$/),
        expect.stringMatching(/^http_503@\d+\.\ds$/),
      ],
    });
  });

  it("does not retry a non-retryable failure (advances the chain instead)", async () => {
    const { logger, warn } = spyLogger();
    let n = 0;
    const m = composeFallback(
      [
        leaf("xai", "grok", () => {
          n += 1;
          return Promise.reject(apiErr(400, false));
        }),
        leaf("openai", "gpt", () => Promise.resolve(genResult([{ type: "text", text: "ok" }]))),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(n).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe("llm.fallback");
  });

  it("emits an error span after exhausting every attempt, then rethrows", async () => {
    const { logger, info } = spyLogger();
    const m = composeFallback([leaf("xai", "grok", () => Promise.reject(apiErr(503, true)))], {
      logger,
      service: "s",
      retry: { ...fastRetry, maxAttempts: 2 },
    });
    await expect(m.doGenerate({} as unknown as LanguageModelV3CallOptions)).rejects.toThrow(
      "status 503",
    );
    expect(info).toHaveBeenCalledTimes(1);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "error" });
    expect(fields.llm).toMatchObject({
      provider: "xai",
      prompt_tokens: 0,
      completion_tokens: 0,
      attempts: 2,
    });
  });

  it("stops retry AND failover once the caller's signal has aborted", async () => {
    const { logger, info } = spyLogger();
    const ac = new AbortController();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const m = composeFallback(
      [
        leaf("xai", "grok", () => {
          primaryCalls += 1;
          ac.abort();
          const e = new Error("The operation was aborted due to timeout");
          e.name = "TimeoutError";
          return Promise.reject(e);
        }),
        leaf("openai", "gpt", () => {
          fallbackCalls += 1;
          return Promise.resolve(genResult([{ type: "text", text: "never" }]));
        }),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    await expect(
      m.doGenerate({ abortSignal: ac.signal } as unknown as LanguageModelV3CallOptions),
    ).rejects.toThrow(/aborted/);
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "error" });
    expect(fields.llm).toMatchObject({
      attempts: 1,
      attempt_errors: [expect.stringMatching(/^xai:aborted@\d+\.\ds$/)],
    });
  });

  it("honors a caller abort that lands during the backoff sleep (no phantom attempt)", async () => {
    const { logger, info } = spyLogger();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const ac = new AbortController();
      let n = 0;
      const m = composeFallback(
        [
          leaf("xai", "grok", () => {
            n += 1;
            return Promise.reject(apiErr(503, true));
          }),
        ],
        // ~4950ms deterministic backoff (random pinned) — far longer than the abort below.
        { logger, service: "s", retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 5_000 } },
      );
      setTimeout(() => ac.abort(), 20);
      const startedAt = Date.now();
      await expect(
        m.doGenerate({ abortSignal: ac.signal } as unknown as LanguageModelV3CallOptions),
      ).rejects.toHaveProperty("name", "AbortError");
      expect(Date.now() - startedAt).toBeLessThan(2_000); // backoff was interrupted, not slept out
      expect(n).toBe(1); // no attempt launched against the dead signal
      const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
      expect(fields.event).toMatchObject({ status: "error" });
      expect(fields.llm).toMatchObject({
        attempts: 1,
        attempt_errors: [expect.stringMatching(/^http_503@\d+\.\ds$/)],
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("rejects without calling any provider when the signal is already aborted", async () => {
    const { logger, info } = spyLogger();
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    const m = composeFallback(
      [
        leaf("xai", "grok", () => {
          n += 1;
          return Promise.resolve(genResult([{ type: "text", text: "x" }]));
        }),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    await expect(
      m.doGenerate({ abortSignal: ac.signal } as unknown as LanguageModelV3CallOptions),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(n).toBe(0);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "error" });
    expect(fields.llm).toMatchObject({ attempts: 0 });
  });

  it("keeps a genuine provider error's label when it races the caller's abort", async () => {
    const { logger, info } = spyLogger();
    const ac = new AbortController();
    const m = composeFallback(
      [
        leaf("xai", "grok", () => {
          ac.abort();
          return Promise.reject(apiErr(429, false));
        }),
        leaf("openai", "gpt", () => Promise.resolve(genResult([{ type: "text", text: "never" }]))),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    await expect(
      m.doGenerate({ abortSignal: ac.signal } as unknown as LanguageModelV3CallOptions),
    ).rejects.toThrow("status 429");
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.llm).toMatchObject({
      attempts: 1,
      attempt_errors: [expect.stringMatching(/^xai:http_429@\d+\.\ds$/)],
    });
  });

  it("clamps maxAttempts to at least 1 and rethrows the real error", async () => {
    const { logger, info } = spyLogger();
    const m = composeFallback([leaf("xai", "grok", () => Promise.reject(apiErr(400, false)))], {
      logger,
      service: "s",
      retry: { maxAttempts: 0 },
    });
    await expect(m.doGenerate({} as unknown as LanguageModelV3CallOptions)).rejects.toThrow(
      "status 400",
    );
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.llm).toMatchObject({ attempts: 1 });
  });

  it("retries the stream handshake and emits a zero-token ok span", async () => {
    const { logger, info } = spyLogger();
    let n = 0;
    const handshake = { stream: "fake" } as unknown as StreamHandshake;
    const m = composeFallback(
      [
        leaf(
          "xai",
          "grok",
          () => Promise.reject(new Error("doGenerate not exercised")),
          () => {
            n += 1;
            if (n < 2) return Promise.reject(apiErr(503, true));
            return Promise.resolve(handshake);
          },
        ),
      ],
      { logger, service: "s", retry: fastRetry },
    );
    const res = await m.doStream({} as unknown as LanguageModelV3CallOptions);
    expect(res).toBe(handshake);
    expect(n).toBe(2);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "ok" });
    expect(fields.llm).toMatchObject({ attempts: 2, prompt_tokens: 0, completion_tokens: 0 });
  });

  it("gives every attempt a fresh, unaborted deadline (timeoutMiddleware composition)", async () => {
    const { logger } = spyLogger();
    const seen: (AbortSignal | undefined)[] = [];
    const abortedAtCall: boolean[] = [];
    let n = 0;
    const recording: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "fake",
      modelId: "fake-model",
      supportedUrls: {},
      doGenerate: (options: LanguageModelV3CallOptions) => {
        seen.push(options.abortSignal);
        abortedAtCall.push(options.abortSignal?.aborted ?? false);
        n += 1;
        if (n === 1) return Promise.reject(apiErr(503, true));
        return Promise.resolve(genResult([{ type: "text", text: "ok" }]));
      },
      doStream: () => Promise.reject(new Error("doStream not exercised")),
    };
    const wrapped = wrapLanguageModel({ model: recording, middleware: timeoutMiddleware(5_000) });
    const m = composeFallback([{ model: wrapped, provider: "xai", modelId: "grok" }], {
      logger,
      service: "s",
      retry: fastRetry,
    });
    await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
    expect(seen[0]).not.toBe(seen[1]); // the deadline resets per attempt
    expect(abortedAtCall).toEqual([false, false]);
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
      status: "ok",
      attempts: 1,
    });
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("llm.generate");
    expect(fields.event).toEqual({
      kind: "span",
      name: "llm.generate",
      duration_ms: 12,
      status: "ok",
    });
    expect(fields.llm).toMatchObject({ service: "kioku", prompt_tokens: 3, fallback_used: false });
    expect(fields.llm).toMatchObject({ attempts: 1 });
    expect(fields.llm).not.toHaveProperty("attempt_errors");
    expect(fields.trace).toBeUndefined();
  });

  it("carries error status and attempt history on a failed call", () => {
    const { logger, info } = spyLogger();
    emitUsage(logger, {
      service: "kokoro",
      provider: "xai",
      model: "grok",
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 82000,
      fallbackUsed: false,
      status: "error",
      attempts: 3,
      attemptErrors: ["TimeoutError@30.0s", "TimeoutError@30.0s", "aborted@21.3s"],
    });
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "error" });
    expect(fields.llm).toMatchObject({
      attempts: 3,
      attempt_errors: ["TimeoutError@30.0s", "TimeoutError@30.0s", "aborted@21.3s"],
    });
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
        status: "ok",
        attempts: 1,
      }),
    );
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.trace).toEqual({ id: ctx.traceId });
    expect(fields.span).toMatchObject({ parent: { id: ctx.spanId } });
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
    expect(fields.event).toMatchObject({ status: "ok" });
    expect(fields.llm).toMatchObject({
      provider: "anthropic",
      model: "claude",
      prompt_tokens: 11,
      completion_tokens: 22,
      fallback_used: false,
      attempts: 1,
    });
  });

  it("fails over same-tier to the next provider and flags fallbackUsed", async () => {
    const { logger, info, warn } = spyLogger();
    const m = composeFallback(
      [
        leaf("anthropic", "claude-smart", () => Promise.reject(apiErr(503, true))),
        leaf("xai", "grok-smart", () => Promise.resolve(genResult([{ type: "text", text: "z" }]))),
      ],
      { logger, service: "kokoro", retry: { maxAttempts: 1 } },
    );
    const res = await m.doGenerate({} as unknown as LanguageModelV3CallOptions);
    expect(res.content).toEqual([{ type: "text", text: "z" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [warnFields] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(warnFields).toMatchObject({ from: "anthropic", to: "xai" });
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.llm).toMatchObject({ provider: "xai", fallback_used: true, attempts: 2 });
  });

  it("throws the last error when every provider in the tier fails", async () => {
    const { logger, info } = spyLogger();
    const m = composeFallback(
      [
        leaf("a", "m1", () => Promise.reject(apiErr(500, true))),
        leaf("b", "m2", () => Promise.reject(new Error("final boom"))),
      ],
      { logger, service: "s", retry: { maxAttempts: 1 } },
    );
    await expect(m.doGenerate({} as unknown as LanguageModelV3CallOptions)).rejects.toThrow(
      "final boom",
    );
    // The terminal failure still produces exactly one span, with the history.
    expect(info).toHaveBeenCalledTimes(1);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.event).toMatchObject({ status: "error" });
    expect(fields.llm).toMatchObject({
      provider: "b",
      model: "m2",
      fallback_used: true,
      attempts: 2,
      attempt_errors: [
        expect.stringMatching(/^a:http_500@\d+\.\ds$/),
        expect.stringMatching(/^b:Error@\d+\.\ds$/),
      ],
    });
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
