import { childSpan, generateSpanId, getTraceContext } from "@kagami/logger";
import type { Logger } from "@kagami/logger";
import type { UsageEvent } from "./types.js";

/**
 * The observability seam (SPEC.md §6).
 *
 * On this base (`origin/main`) `@kagami/logger` has no `runWithSpan`, so this
 * reconstructs an equivalent build-light span from the primitives that *are*
 * present (`getTraceContext` + `childSpan` + `generateSpanId`) and emits one
 * ECS-shaped `event.kind:"span"` line through the **caller's** logger.
 *
 * This is the single place that knows *how* a span is emitted. When
 * `logging-prod-hardening` lands `runWithSpan`, only this function body
 * changes — `emitUsage`'s signature, and therefore every caller and the
 * package's public API, stay byte-identical.
 */
export function emitUsage(logger: Logger, ev: UsageEvent): void {
  const ctx = getTraceContext();
  const span = ctx ? childSpan(ctx) : undefined;

  const fields: Record<string, unknown> = {
    event: { kind: "span" },
    span: {
      id: span?.spanId ?? generateSpanId(),
      name: "llm.generate",
      duration_ms: ev.durationMs,
      ...(span ? { parent_id: span.parentSpanId } : {}),
    },
    llm: {
      service: ev.service,
      provider: ev.provider,
      model: ev.model,
      prompt_tokens: ev.promptTokens,
      completion_tokens: ev.completionTokens,
      fallback_used: ev.fallbackUsed,
    },
  };
  if (ctx) fields.trace = { id: ctx.traceId };

  logger.info(fields, "llm.generate");
}
