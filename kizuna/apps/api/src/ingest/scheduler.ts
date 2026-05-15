import { withRootTrace } from "@kagami/logger/trace";
import type { Config } from "../config.js";
import { logger } from "../lib/logger.js";
import { runCalendarSyncOnce } from "./calendar.js";
import { runGmailSyncOnce } from "./gmail.js";

export type Scheduler = {
  stop(): void;
};

/**
 * Run Gmail + Calendar ingest on an interval. Each tick runs the two
 * workers sequentially. A re-entrancy guard ensures a slow tick never
 * overlaps with the next one. Disabled when intervalSec is 0.
 *
 * Manual triggers via POST /sync/{gmail,gcal}/run remain available
 * regardless of the scheduler.
 */
// Idle ticks (nothing fetched, no errors, still ok) are pure steady-state
// noise — demote to debug. Surface info only when something actually
// happened or the sync isn't healthy; escalate to warn on per-run errors.
function logTick(
  provider: "gmail" | "gcal",
  status: string,
  changed: number,
  errors: number,
  result: object,
): void {
  const fields = { provider, ...result };
  if (errors > 0) {
    logger.warn(fields, `${provider} ingest tick: ${errors} error(s)`);
  } else if (changed > 0 || status !== "ok") {
    logger.info(fields, `${provider} ingest tick`);
  } else {
    logger.debug(fields, `${provider} ingest tick (idle)`);
  }
}

export function startIngestScheduler(args: { config: Config }): Scheduler {
  const { config } = args;
  const intervalSec = config.KIZUNA_INGEST_INTERVAL_SEC;
  if (intervalSec <= 0) {
    logger.info("ingest scheduler disabled (KIZUNA_INGEST_INTERVAL_SEC=0)");
    return { stop() {} };
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn("ingest tick skipped: previous tick still running");
      return;
    }
    running = true;
    try {
      const gmail = await runGmailSyncOnce(config);
      logTick("gmail", gmail.status, gmail.inserted, gmail.errors, gmail);
      const gcal = await runCalendarSyncOnce(config);
      logTick("gcal", gcal.status, gcal.upserted, gcal.errors, gcal);
    } catch (err) {
      logger.error({ err }, "ingest tick failed");
    } finally {
      running = false;
    }
  };

  // Each ingest tick runs in its own root trace so its Gmail + Calendar
  // sync logs share a traceId and the eventual Kansoku export carries it.
  const handle = setInterval(
    withRootTrace(() => tick()),
    intervalSec * 1000,
  );
  // Don't run on boot — first tick fires after the interval. Avoids surprise
  // sync runs on dev-server restarts (tsx watch).
  logger.info({ intervalSec }, "ingest scheduler started");
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
