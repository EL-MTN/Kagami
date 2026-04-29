import {
  archiveExpiredWatchers,
  claimPendingManualWatcherRun,
  getDueWatchers,
  resetStaleRunningWatcherLogs,
} from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { executeWatcher } from "../services/watcher-executor";

const POLL_INTERVAL_MS = 60_000; // cron tick: 1 minute
const MANUAL_POLL_INTERVAL_MS = 3_000; // manual-run tick: 3 seconds

let interval: NodeJS.Timeout | null = null;
let manualInterval: NodeJS.Timeout | null = null;

async function runDueWatchers(adapter: PlatformAdapter): Promise<void> {
  try {
    const watchers = await getDueWatchers();
    if (watchers.length === 0) return;

    logger.info({ count: watchers.length }, "Executing due watchers");

    for (const watcher of watchers) {
      try {
        await executeWatcher(watcher, adapter, {
          trigger: "cron",
          advanceSchedule: true,
        });
      } catch (error) {
        logger.error(
          { error, watcherId: watcher._id, name: watcher.name },
          "Failed to execute watcher",
        );
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to poll due watchers");
  }
}

async function runPendingManualRequest(adapter: PlatformAdapter): Promise<void> {
  try {
    const watcher = await claimPendingManualWatcherRun();
    if (!watcher) return;

    logger.info({ watcherId: watcher._id, name: watcher.name }, "Executing manual watcher run");
    await executeWatcher(watcher, adapter, {
      trigger: "manual",
      advanceSchedule: false,
      silent: true,
    });
  } catch (error) {
    logger.error({ error }, "Failed to execute manual watcher run");
  }
}

async function startupRecovery(adapter: PlatformAdapter): Promise<void> {
  try {
    const reset = await resetStaleRunningWatcherLogs();
    if (reset > 0) logger.info({ count: reset }, "Reset stale running watcher logs");
  } catch (error) {
    logger.error({ error }, "Failed to reset stale watcher logs");
  }

  try {
    const archived = await archiveExpiredWatchers();
    if (archived > 0) logger.info({ count: archived }, "Archived expired watchers");
  } catch (error) {
    logger.error({ error }, "Failed to archive expired watchers");
  }

  await runDueWatchers(adapter);
}

export function startWatcherScheduler(adapter: PlatformAdapter): () => void {
  void startupRecovery(adapter);

  interval = setInterval(() => {
    void (async () => {
      try {
        await archiveExpiredWatchers();
      } catch (error) {
        logger.error({ error }, "Failed to archive expired watchers");
      }
      await runDueWatchers(adapter);
    })();
  }, POLL_INTERVAL_MS);
  interval.unref();

  manualInterval = setInterval(
    () => void runPendingManualRequest(adapter),
    MANUAL_POLL_INTERVAL_MS,
  );
  manualInterval.unref();

  logger.info("Watcher scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (manualInterval) {
      clearInterval(manualInterval);
      manualInterval = null;
    }
    logger.info("Watcher scheduler stopped");
  };
}
