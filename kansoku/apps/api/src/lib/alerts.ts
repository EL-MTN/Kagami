import { loadEnv } from "../config.js";
import { logger } from "../logger.js";

/**
 * Fire-and-forget alert hooks. The "new-error" payload fires the first time
 * a fingerprint shows up; the "spike" payload fires when an existing
 * fingerprint crosses a rate threshold inside the configured window (and
 * respects a per-fingerprint cooldown so a sustained outage doesn't
 * pager-storm).
 *
 * Both POST a small JSON payload to the same webhook URL that Discord /
 * Slack / generic webhooks can pretty-print without a custom transformer.
 *
 * Fail-open at every step: network errors are swallowed so the ingest path
 * never wedges on an alerting outage.
 */

const ALERT_TIMEOUT_MS = 5_000;

export interface NewErrorPayload {
  kind: "kansoku.error.new";
  fingerprint: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  firstSeen: string;
  traceId?: string;
}

export interface SpikePayload {
  kind: "kansoku.error.spike";
  fingerprint: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  count: number;
  windowMinutes: number;
  windowStart: string;
  lastSeen: string;
  traceId?: string;
}

type AlertPayload = NewErrorPayload | SpikePayload;

interface SpikeConfig {
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

// Defaults, floors, and the strict-integer parse live in the env spec
// (src/env.ts); loadEnv() memoizes on the raw env values, so these per-call
// reads stay cheap on the ingest hot path while a test or operator that
// mutates env mid-flight is transparently picked up on the next call.

export function getWebhookUrl(): string | undefined {
  return loadEnv().KANSOKU_ALERT_WEBHOOK_URL;
}

export function getSpikeConfig(): SpikeConfig {
  const env = loadEnv();
  return {
    threshold: env.KANSOKU_SPIKE_THRESHOLD,
    windowMinutes: env.KANSOKU_SPIKE_WINDOW_MINUTES,
    cooldownMinutes: env.KANSOKU_SPIKE_COOLDOWN_MINUTES,
  };
}

/**
 * Send `payload` to the configured webhook. Fail-open: a missing URL skips
 * silently and any fetch / parse failure is swallowed.
 *
 * Build the body lazily (after the URL check) so a deployment without a
 * webhook configured pays no serialization cost per error. The timeout is
 * driven by `AbortSignal.timeout` — the underlying timer is auto-`unref`'d
 * by Node, so the alert's pending timer alone won't hold the event loop
 * open. The fetch's open socket can still hold the loop; shutdown paths
 * that need to drain in-flight alerts must coordinate with the call sites
 * (today `void postAlert(...)` is detached and `server.ts::shutdown`
 * explicitly calls `process.exit` after closing the HTTP server).
 */
export async function postAlert(payload: AlertPayload): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        { fingerprint: payload.fingerprint, kind: payload.kind, status: res.status },
        "alert webhook returned non-2xx",
      );
    }
  } catch (err) {
    logger.warn(
      { fingerprint: payload.fingerprint, kind: payload.kind, err: (err as Error).message },
      "alert webhook delivery failed",
    );
  }
}
