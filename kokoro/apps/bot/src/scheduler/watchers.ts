import {
  archiveExpiredWatchers,
  claimPendingManualWatcherRun,
  getDueWatchers,
  resetStaleRunningWatcherLogs,
} from "@kokoro/db";
import { logger, withRootTrace } from "@kokoro/shared";
import type { IWatcher } from "@kokoro/db";
import type { PlatformAdapter } from "@kokoro/shared";
import { AdapterRegistry, platformForChatId } from "../platform/registry";
import { executeWatcher } from "../services/watcher-executor";

const POLL_INTERVAL_MS = 60_000; // cron tick: 1 minute
const MANUAL_POLL_INTERVAL_MS = 3_000; // manual-run tick: 3 seconds

let interval: NodeJS.Timeout | null = null;
let manualInterval: NodeJS.Timeout | null = null;

function adapterForWatcher(registry: AdapterRegistry, watcher: IWatcher): PlatformAdapter | null {
  const platform = platformForChatId(watcher.chatId);
  const adapter = registry.get(platform);
  if (!adapter) {
    logger.warn(
      { watcherId: watcher._id, name: watcher.name, chatId: watcher.chatId, platform },
      "Skipping watcher: adapter not registered",
    );
    return null;
  }
  return adapter;
}

async function runDueWatchers(registry: AdapterRegistry): Promise<void> {
  try {
    const watchers = await getDueWatchers();
    if (watchers.length === 0) return;

    logger.info({ count: watchers.length }, "Executing due watchers");

    for (const watcher of watchers) {
      const adapter = adapterForWatcher(registry, watcher);
      if (!adapter) continue;
      try {
        await executeWatcher(watcher, adapter, {
          trigger: "cron",
          advanceSchedule: true,
        });
      } catch (error) {
        logger.error(
          { error: error, watcherId: watcher._id, name: watcher.name },
          "Failed to execute watcher",
        );
      }
    }
  } catch (error) {
    logger.error({ error: error }, "Failed to poll due watchers");
  }
}

async function runPendingManualRequest(registry: AdapterRegistry): Promise<void> {
  try {
    const watcher = await claimPendingManualWatcherRun();
    if (!watcher) return;

    const adapter = adapterForWatcher(registry, watcher);
    if (!adapter) return;

    logger.info({ watcherId: watcher._id, name: watcher.name }, "Executing manual watcher run");
    await executeWatcher(watcher, adapter, {
      trigger: "manual",
      advanceSchedule: false,
      silent: true,
    });
  } catch (error) {
    logger.error({ error: error }, "Failed to execute manual watcher run");
  }
}

async function startupRecovery(registry: AdapterRegistry): Promise<void> {
  try {
    const reset = await resetStaleRunningWatcherLogs();
    if (reset > 0) logger.info({ count: reset }, "Reset stale running watcher logs");
  } catch (error) {
    logger.error({ error: error }, "Failed to reset stale watcher logs");
  }

  try {
    const archived = await archiveExpiredWatchers();
    if (archived > 0) logger.info({ count: archived }, "Archived expired watchers");
  } catch (error) {
    logger.error({ error: error }, "Failed to archive expired watchers (startup recovery)");
  }

  await runDueWatchers(registry);
}

export function startWatcherScheduler(registry: AdapterRegistry): () => void {
  void startupRecovery(registry);

  interval = setInterval(
    withRootTrace(async () => {
      try {
        await archiveExpiredWatchers();
      } catch (error) {
        logger.error({ error: error }, "Failed to archive expired watchers (scheduled poll)");
      }
      await runDueWatchers(registry);
    }),
    POLL_INTERVAL_MS,
  );
  interval.unref();

  manualInterval = setInterval(
    withRootTrace(() => runPendingManualRequest(registry)),
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
