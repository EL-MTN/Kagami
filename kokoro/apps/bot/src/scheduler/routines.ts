import { getDueRoutines, claimPendingManualRun, resetStaleRunningRoutineLogs } from "@kokoro/db";
import { logger, withRootTrace } from "@kokoro/shared";
import type { IRoutine } from "@kokoro/db";
import type { PlatformAdapter } from "@kokoro/shared";
import { AdapterRegistry, platformForChatId } from "../platform/registry";
import { executeRoutine } from "../services/routine-executor";

const POLL_INTERVAL_MS = 60_000; // cron tick: 1 minute
const MANUAL_POLL_INTERVAL_MS = 3_000; // manual-run tick: 3 seconds

let interval: NodeJS.Timeout | null = null;
let manualInterval: NodeJS.Timeout | null = null;

function adapterForRoutine(registry: AdapterRegistry, routine: IRoutine): PlatformAdapter | null {
  const platform = platformForChatId(routine.chatId);
  const adapter = registry.get(platform);
  if (!adapter) {
    logger.warn(
      { routineId: routine._id, name: routine.name, chatId: routine.chatId, platform },
      "Skipping routine: adapter not registered",
    );
    return null;
  }
  return adapter;
}

async function runDueRoutines(registry: AdapterRegistry): Promise<void> {
  try {
    const routines = await getDueRoutines();
    if (routines.length === 0) return;

    logger.info({ count: routines.length }, "Executing due routines");

    for (const routine of routines) {
      const adapter = adapterForRoutine(registry, routine);
      if (!adapter) continue;
      try {
        // Build default parameters from routine definition for cron triggers
        const defaults: Record<string, unknown> = {};
        for (const param of routine.parameters) {
          if (param.default !== undefined) {
            defaults[param.name] = param.default;
          }
        }

        await executeRoutine(routine, adapter, {
          trigger: "cron",
          advanceSchedule: true,
          parameters: Object.keys(defaults).length > 0 ? defaults : undefined,
        });
      } catch (error) {
        logger.error(
          { error: error, routineId: routine._id, name: routine.name },
          "Failed to execute routine",
        );
      }
    }
  } catch (error) {
    logger.error({ error: error }, "Failed to poll due routines");
  }
}

async function runPendingManualRequest(registry: AdapterRegistry): Promise<void> {
  try {
    const routine = await claimPendingManualRun();
    if (!routine) return;

    const adapter = adapterForRoutine(registry, routine);
    if (!adapter) return;

    const params: Record<string, unknown> = {};
    for (const p of routine.parameters) {
      if (p.default !== undefined) params[p.name] = p.default;
    }

    logger.info({ routineId: routine._id, name: routine.name }, "Executing manual run request");
    await executeRoutine(routine, adapter, {
      trigger: "manual",
      advanceSchedule: false,
      silent: true,
      parameters: Object.keys(params).length > 0 ? params : undefined,
    });
  } catch (error) {
    logger.error({ error: error }, "Failed to execute manual run request");
  }
}

async function startupRecovery(registry: AdapterRegistry): Promise<void> {
  // Clean up stale "running" logs from crashed executions first
  try {
    const count = await resetStaleRunningRoutineLogs();
    if (count > 0) {
      logger.info({ count }, "Reset stale running routine logs");
    }
  } catch (error) {
    logger.error({ error: error }, "Failed to reset stale routine logs");
  }

  // Then run any due routines
  await runDueRoutines(registry);
}

export function startRoutineScheduler(registry: AdapterRegistry): () => void {
  // Startup recovery: await stale reset before first poll
  void startupRecovery(registry);

  // Each tick is its own root trace so cron-fire logs / manual-fire logs
  // and any downstream Kioku/Kizuna calls share a single traceId per fire.
  interval = setInterval(
    withRootTrace(() => runDueRoutines(registry)),
    POLL_INTERVAL_MS,
  );
  interval.unref();

  manualInterval = setInterval(
    withRootTrace(() => runPendingManualRequest(registry)),
    MANUAL_POLL_INTERVAL_MS,
  );
  manualInterval.unref();

  logger.info("Routine scheduler started");

  return () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (manualInterval) {
      clearInterval(manualInterval);
      manualInterval = null;
    }
    logger.info("Routine scheduler stopped");
  };
}
