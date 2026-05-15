import { logger } from "../logger.js";

/**
 * Fire-and-forget alert hook called from the ingest path when a brand-new
 * error fingerprint shows up. Sends a small JSON payload that Discord /
 * Slack / generic webhooks can pretty-print without a custom transformer.
 *
 * Fail-open at every step: network errors are swallowed so the ingest path
 * never wedges on an alerting outage.
 */

const ALERT_TIMEOUT_MS = 5_000;

export interface NewErrorAlert {
  fingerprint: string;
  service: string;
  component: string;
  name?: string;
  message: string;
  firstSeen: Date;
  traceId?: string;
}

function getWebhookUrl(): string | undefined {
  const v = process.env.KANSOKU_ALERT_WEBHOOK_URL;
  return v && v.trim().length > 0 ? v : undefined;
}

export async function notifyNewError(alert: NewErrorAlert): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
  try {
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(
        { fingerprint: alert.fingerprint, status: res.status },
        "alert webhook returned non-2xx",
      );
    }
  } catch (err) {
    logger.warn(
      { fingerprint: alert.fingerprint, err: (err as Error).message },
      "alert webhook delivery failed",
    );
  } finally {
    clearTimeout(timer);
  }
}
