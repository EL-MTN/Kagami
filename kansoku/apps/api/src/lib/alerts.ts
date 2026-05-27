import { logger } from "../logger.js";

/**
 * Fire-and-forget alert hooks. The "new-error" hook fires the first time a
 * fingerprint shows up; the "spike" hook fires when an existing fingerprint
 * crosses a rate threshold inside the configured window (and respects a
 * per-fingerprint cooldown so a sustained outage doesn't pager-storm).
 *
 * Both POST a small JSON payload to the same webhook URL that Discord /
 * Slack / generic webhooks can pretty-print without a custom transformer.
 *
 * Fail-open at every step: network errors are swallowed so the ingest path
 * never wedges on an alerting outage.
 */

const ALERT_TIMEOUT_MS = 5_000;
const DEFAULT_SPIKE_THRESHOLD = 10;
const DEFAULT_SPIKE_WINDOW_MINUTES = 5;
const DEFAULT_SPIKE_COOLDOWN_MINUTES = 60;

export interface NewErrorAlert {
  fingerprint: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  firstSeen: Date;
  traceId?: string;
}

export interface SpikeAlert {
  fingerprint: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  count: number;
  windowMinutes: number;
  windowStart: Date;
  lastSeen: Date;
  traceId?: string;
}

export interface SpikeConfig {
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

function getWebhookUrl(): string | undefined {
  const v = process.env.KANSOKU_ALERT_WEBHOOK_URL;
  return v && v.trim().length > 0 ? v : undefined;
}

/**
 * Strict integer parse with a floor of 1. Matches the posture of
 * `resolveTtlSeconds` in storage/indexes.ts — `"10x"` → fallback + warn.
 */
function resolvePositiveInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    logger.warn(
      { envVar, provided: raw, fallback: defaultValue },
      `${envVar} not a positive integer; using default`,
    );
    return defaultValue;
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < 1) {
    logger.warn(
      { envVar, provided: raw, fallback: defaultValue },
      `${envVar} must be >= 1; using default`,
    );
    return defaultValue;
  }
  return n;
}

export function getSpikeConfig(): SpikeConfig {
  return {
    threshold: resolvePositiveInt("KANSOKU_SPIKE_THRESHOLD", DEFAULT_SPIKE_THRESHOLD),
    windowMinutes: resolvePositiveInt("KANSOKU_SPIKE_WINDOW_MINUTES", DEFAULT_SPIKE_WINDOW_MINUTES),
    cooldownMinutes: resolvePositiveInt(
      "KANSOKU_SPIKE_COOLDOWN_MINUTES",
      DEFAULT_SPIKE_COOLDOWN_MINUTES,
    ),
  };
}

async function postAlert(kind: string, fingerprint: string, body: string): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ fingerprint, kind, status: res.status }, "alert webhook returned non-2xx");
    }
  } catch (err) {
    logger.warn(
      { fingerprint, kind, err: (err as Error).message },
      "alert webhook delivery failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyNewError(alert: NewErrorAlert): Promise<void> {
  const body = JSON.stringify({
    kind: "kansoku.error.new",
    fingerprint: alert.fingerprint,
    service: alert.service,
    component: alert.component,
    name: alert.name,
    message: alert.message,
    firstSeen: alert.firstSeen.toISOString(),
    traceId: alert.traceId,
  });
  await postAlert("kansoku.error.new", alert.fingerprint, body);
}

export async function notifySpike(alert: SpikeAlert): Promise<void> {
  const body = JSON.stringify({
    kind: "kansoku.error.spike",
    fingerprint: alert.fingerprint,
    service: alert.service,
    component: alert.component,
    name: alert.name,
    message: alert.message,
    count: alert.count,
    windowMinutes: alert.windowMinutes,
    windowStart: alert.windowStart.toISOString(),
    lastSeen: alert.lastSeen.toISOString(),
    traceId: alert.traceId,
  });
  await postAlert("kansoku.error.spike", alert.fingerprint, body);
}
