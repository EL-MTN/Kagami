import {
  cleanupOldConversations,
  cleanupFiredReminders,
  cleanupOldRoutineLogs,
  cleanupOldWatcherLogs,
  cleanupOldLocations,
} from "@kokoro/db";
import { logger } from "@kokoro/shared";
import { sweepPendingIngests, sweepStaleActiveSessions } from "@kokoro/memory";

const CLEANUP_INTERVAL = 24 * 60 * 60_000; // 24 hours
const KIOKU_SWEEP_INTERVAL = 5 * 60_000; // 5 minutes
const STARTUP_CLEANUP_DELAY = 60_000; // 1 minute
const STARTUP_SWEEP_DELAY = 30_000; // 30 seconds

let cleanupTimer: NodeJS.Timeout | null = null;
let kiokuSweepTimer: NodeJS.Timeout | null = null;

async function runKiokuSweep(): Promise<void> {
  // Backstops the per-call-site `ingestClosedSession` trigger. The
  // immediate trigger is best-effort; this sweeper drives any stuck
  // `closed && pending` rows to `done`, retrying through Kioku
  // outages, and closes long-idle `active` sessions that never got a
  // rollover. Running both on the same tick — the stale-active query
  // is indexed and cheap when there's no work.
  try {
    await sweepStaleActiveSessions();
  } catch (error) {
    logger.error({ error }, "Kioku stale-active sweep failed");
  }
  try {
    await sweepPendingIngests();
  } catch (error) {
    logger.error({ error }, "Kioku pending-ingest sweep failed");
  }
}

async function runDailyCleanup(): Promise<void> {
  try {
    const [deletedReminders, deletedConvos, deletedLogs, deletedWatcherLogs, deletedLocations] =
      await Promise.all([
        cleanupFiredReminders(30),
        cleanupOldConversations(90),
        cleanupOldRoutineLogs(90),
        cleanupOldWatcherLogs(90),
        cleanupOldLocations(90),
      ]);
    if (
      deletedReminders > 0 ||
      deletedConvos > 0 ||
      deletedLogs > 0 ||
      deletedWatcherLogs > 0 ||
      deletedLocations > 0
    ) {
      logger.info(
        { deletedReminders, deletedConvos, deletedLogs, deletedWatcherLogs, deletedLocations },
        "Daily cleanup complete",
      );
    }
  } catch (error) {
    logger.error({ error }, "Daily cleanup failed");
  }
}

export function startMaintenanceScheduler(): () => void {
  cleanupTimer = setInterval(() => {
    runDailyCleanup().catch((error) => {
      logger.error({ error }, "Cleanup interval failed");
    });
  }, CLEANUP_INTERVAL);

  setTimeout(() => {
    runDailyCleanup().catch((error) => {
      logger.error({ error }, "Startup cleanup failed");
    });
  }, STARTUP_CLEANUP_DELAY);

  // Kioku ingest sweeper backstops the per-call-site immediate trigger.
  kiokuSweepTimer = setInterval(() => {
    runKiokuSweep().catch((error) => {
      logger.error({ error }, "Kioku sweep interval failed");
    });
  }, KIOKU_SWEEP_INTERVAL);

  // Run once on startup (after a brief delay so the bot is fully up)
  // — covers the case where Kioku was unavailable when the previous
  // process closed sessions.
  setTimeout(() => {
    runKiokuSweep().catch((error) => {
      logger.error({ error }, "Startup Kioku sweep failed");
    });
  }, STARTUP_SWEEP_DELAY);

  logger.info("Maintenance scheduler started");

  return () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    if (kiokuSweepTimer) {
      clearInterval(kiokuSweepTimer);
      kiokuSweepTimer = null;
    }
    logger.info("Maintenance scheduler stopped");
  };
}
