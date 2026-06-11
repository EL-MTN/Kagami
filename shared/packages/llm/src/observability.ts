import { childSpan, generateSpanId, getTraceContext } from "@kagami/logger";
import type { Logger } from "@kagami/logger";
import type { UsageEvent } from "./types.js";

/**
 * The observability seam: emit one ECS `event.kind:"span"` line per completed
 * inference, enriched with this call's LLM token usage, through the caller's
 * logger.
 *
 * `@kagami/logger` exports `runWithSpan`, but it wraps-and-times a function
 * and emits a *generic* span — it has no hook to attach this call's `llm.*`
 * token fields or the fallback-composite-measured duration. So `emitUsage`
 * deliberately builds the span line from the lower-level primitives
 * (`getTraceContext` + `childSpan` + `generateSpanId`); it is a tailored
 * usage-span emitter, not a `runWithSpan` substitute, and is the single
 * place that knows how this span is shaped.
 */
export function emitUsage(logger: Logger, ev: UsageEvent): void {
  const ctx = getTraceContext();
  const span = ctx ? childSpan(ctx) : undefined;

  const fields: Record<string, unknown> = {
    event: {
      kind: "span",
      name: "llm.generate",
      duration_ms: ev.durationMs,
      status: ev.status,
    },
    span: {
      id: span?.spanId ?? generateSpanId(),
      ...(span ? { parent: { id: span.parentSpanId } } : {}),
    },
    llm: {
      service: ev.service,
      provider: ev.provider,
      model: ev.model,
      prompt_tokens: ev.promptTokens,
      completion_tokens: ev.completionTokens,
      fallback_used: ev.fallbackUsed,
      attempts: ev.attempts,
      ...(ev.attemptErrors && ev.attemptErrors.length > 0
        ? { attempt_errors: ev.attemptErrors }
        : {}),
    },
  };
  if (ctx) fields.trace = { id: ctx.traceId };

  // info even for status:"error" — Kansoku fingerprints error-level lines, and
  // the caller already logs the failure itself; an error-level span here would
  // register every failed call twice in the errors registry.
  logger.info(fields, "llm.generate");
}
