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
      logger.info({ provider: "gmail", ...gmail }, "ingest tick");
      const gcal = await runCalendarSyncOnce(config);
      logger.info({ provider: "gcal", ...gcal }, "ingest tick");
    } catch (err) {
      logger.error({ err }, "ingest tick failed");
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalSec * 1000);
  // Don't run on boot — first tick fires after the interval. Avoids surprise
  // sync runs on dev-server restarts (tsx watch).
  logger.info({ intervalSec }, "ingest scheduler started");
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
