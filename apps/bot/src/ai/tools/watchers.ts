import { tool } from "ai";
import { z } from "zod";
import {
  createWatcher,
  listWatchersForChat,
  getWatcherById,
  updateWatcher,
  deleteWatcher,
  defaultExpiresAt,
  isDuplicateKeyError,
} from "@kokoro/db";
import { config, logger, computeNextRunAt, validateCronAndDefaults } from "@kokoro/shared";

// ─── manageWatchers ──────────────────────────────────────────────────────────

const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" });

export function createManageWatchersTool(chatId: string) {
  return tool({
    description:
      "Manage watchers — scheduled detection jobs that monitor for change and notify Goshujin-sama only when a condition is met (price drops, listing matches, inbox events, etc.). Watchers are read-only by design: they observe and report. Lifecycle controls (oneShot, maxFires, cooldownMinutes) bound how often a watcher fires. Use the `snooze` action to silence a watcher temporarily without disabling it.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "update", "delete", "enable", "disable", "snooze"]),
      watcherId: z
        .string()
        .optional()
        .describe("Watcher ID (required for update/delete/enable/disable/snooze)"),
      name: z
        .string()
        .optional()
        .describe("Unique watcher name (required for create, used as identifier)"),
      description: z
        .string()
        .optional()
        .describe("Short description shown when listing watchers (required for create)"),
      prompt: z
        .string()
        .optional()
        .describe(
          "Detection task — what to check, what to compare against, what counts as a trigger (required for create)",
        ),
      cronSchedule: z
        .string()
        .optional()
        .describe("Cron expression for how often to check (required for create)"),
      expiresAt: isoDatetime
        .optional()
        .describe("ISO 8601 datetime when this watcher should auto-archive. Defaults to 30 days."),
      oneShot: z
        .boolean()
        .optional()
        .describe("If true, archive the watcher after the first real fire."),
      maxFires: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Archive after this many real fires. Pass null/omit for unlimited."),
      cooldownMinutes: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Minimum minutes between notifications. Triggers within the window are silenced (still logged).",
        ),
      untilHours: z
        .number()
        .positive()
        .optional()
        .describe("Hours to snooze for, used with the `snooze` action."),
    }),
    execute: async ({
      action,
      watcherId,
      name,
      description,
      prompt,
      cronSchedule,
      expiresAt,
      oneShot,
      maxFires,
      cooldownMinutes,
      untilHours,
    }) => {
      try {
        switch (action) {
          case "create": {
            if (!name || !description || !prompt || !cronSchedule) {
              return {
                success: false,
                reason:
                  "name, description, prompt, and cronSchedule are required to create a watcher",
              };
            }

            if (!cronSchedule.trim()) {
              return { success: false, reason: "cronSchedule cannot be empty" };
            }

            const cronError = validateCronAndDefaults(cronSchedule, []);
            if (cronError) return { success: false, reason: cronError.message };

            // External observation tools aren't strictly required (memory-only
            // watchers can detect new facts), but most useful watchers need
            // webSearch, browse, or email. Warn so misconfigured deployments
            // surface it.
            if (
              !config.BRAVE_SEARCH_API_KEY &&
              !config.BROWSER_ENABLED &&
              !config.GOOGLE_OAUTH_CLIENT_ID
            ) {
              logger.warn(
                { chatId, name },
                "Creating watcher with no external observation tools (BRAVE_SEARCH_API_KEY, BROWSER_ENABLED, GOOGLE_OAUTH_CLIENT_ID all unset). Watcher will only see memory.",
              );
            }

            logger.info(
              { chatId, name, cronSchedule, oneShot, maxFires, cooldownMinutes },
              "Tool: manageWatchers (create)",
            );

            const nextRunAt = computeNextRunAt(cronSchedule);
            const expires = expiresAt ? new Date(expiresAt) : defaultExpiresAt();

            const watcher = await createWatcher(chatId, {
              name,
              description,
              prompt,
              cronSchedule,
              nextRunAt,
              expiresAt: expires,
              oneShot: oneShot ?? false,
              maxFires: maxFires ?? null,
              cooldownMs:
                cooldownMinutes != null && cooldownMinutes > 0 ? cooldownMinutes * 60_000 : null,
            });

            return {
              success: true,
              watcherId: watcher._id,
              name,
              description,
              cronSchedule,
              nextRunAt: nextRunAt.toISOString(),
              expiresAt: expires.toISOString(),
              oneShot: watcher.oneShot,
              maxFires: watcher.maxFires,
              cooldownMs: watcher.cooldownMs,
            };
          }

          case "list": {
            logger.info({ chatId }, "Tool: manageWatchers (list)");
            const watchers = await listWatchersForChat(chatId);
            return {
              success: true,
              count: watchers.length,
              watchers: watchers.map((w) => ({
                id: w._id,
                name: w.name,
                description: w.description,
                prompt: w.prompt,
                cronSchedule: w.cronSchedule,
                enabled: w.enabled,
                version: w.version,
                fireCount: w.fireCount,
                lastFiredAt: w.lastFiredAt?.toISOString() ?? null,
                nextRunAt: w.nextRunAt?.toISOString() ?? null,
                expiresAt: w.expiresAt?.toISOString() ?? null,
                oneShot: w.oneShot,
                maxFires: w.maxFires,
                cooldownMs: w.cooldownMs,
                snoozedUntil: w.snoozedUntil?.toISOString() ?? null,
              })),
            };
          }

          case "update": {
            if (!watcherId) {
              return { success: false, reason: "watcherId is required for update" };
            }
            logger.info({ watcherId }, "Tool: manageWatchers (update)");

            const existing = await getWatcherById(watcherId, chatId);
            if (!existing) return { success: false, reason: "Watcher not found" };

            const patch: Record<string, unknown> = {};
            if (name) patch.name = name;
            if (description) patch.description = description;
            if (prompt) patch.prompt = prompt;
            if (expiresAt !== undefined) patch.expiresAt = new Date(expiresAt);
            if (oneShot !== undefined) patch.oneShot = oneShot;
            if (maxFires !== undefined) patch.maxFires = maxFires;
            if (cooldownMinutes !== undefined) {
              patch.cooldownMs = cooldownMinutes === 0 ? null : cooldownMinutes * 60_000;
            }

            if (cronSchedule !== undefined) {
              if (!cronSchedule.trim()) {
                return { success: false, reason: "cronSchedule cannot be empty" };
              }
              const cronErr = validateCronAndDefaults(cronSchedule, []);
              if (cronErr) return { success: false, reason: cronErr.message };
              patch.cronSchedule = cronSchedule;
              patch.nextRunAt = computeNextRunAt(cronSchedule);
            }

            if (Object.keys(patch).length === 0) {
              return { success: false, reason: "No fields supplied to update" };
            }

            patch.version = existing.version + 1;

            const updated = await updateWatcher(watcherId, patch, chatId);
            return updated
              ? { success: true, watcherId, version: updated.version, updated: Object.keys(patch) }
              : { success: false, reason: "Watcher not found" };
          }

          case "delete": {
            if (!watcherId) {
              return { success: false, reason: "watcherId is required for delete" };
            }
            logger.info({ watcherId }, "Tool: manageWatchers (delete)");
            const deleted = await deleteWatcher(watcherId, chatId);
            return deleted
              ? { success: true, deleted: watcherId }
              : { success: false, reason: "Watcher not found" };
          }

          case "enable": {
            if (!watcherId) {
              return { success: false, reason: "watcherId is required for enable" };
            }
            logger.info({ watcherId }, "Tool: manageWatchers (enable)");
            const enabled = await updateWatcher(watcherId, { enabled: true }, chatId);
            return enabled
              ? { success: true, watcherId, enabled: true }
              : { success: false, reason: "Watcher not found" };
          }

          case "disable": {
            if (!watcherId) {
              return { success: false, reason: "watcherId is required for disable" };
            }
            logger.info({ watcherId }, "Tool: manageWatchers (disable)");
            const disabled = await updateWatcher(watcherId, { enabled: false }, chatId);
            return disabled
              ? { success: true, watcherId, enabled: false }
              : { success: false, reason: "Watcher not found" };
          }

          case "snooze": {
            if (!watcherId) {
              return { success: false, reason: "watcherId is required for snooze" };
            }
            if (untilHours == null || !Number.isFinite(untilHours) || untilHours <= 0) {
              return {
                success: false,
                reason: "untilHours (positive finite number) is required for snooze",
              };
            }
            const snoozedUntil = new Date(Date.now() + untilHours * 60 * 60 * 1000);
            logger.info({ watcherId, untilHours, snoozedUntil }, "Tool: manageWatchers (snooze)");
            const snoozed = await updateWatcher(watcherId, { snoozedUntil }, chatId);
            return snoozed
              ? {
                  success: true,
                  watcherId,
                  snoozedUntil: snoozedUntil.toISOString(),
                }
              : { success: false, reason: "Watcher not found" };
          }
        }
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return {
            success: false,
            reason: `A watcher named "${name ?? "(unknown)"}" already exists`,
          };
        }
        logger.error({ error, action }, "Tool: manageWatchers failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Watcher operation failed",
        };
      }
    },
  });
}

// ─── reportWatcherResult ─────────────────────────────────────────────────────

export const REPORT_WATCHER_RESULT_TOOL_NAME = "reportWatcherResult";

export interface WatcherResult {
  triggered: boolean;
  summary: string;
  newState: string;
}

export const reportWatcherResultInputSchema = z.object({
  triggered: z
    .boolean()
    .describe(
      "true if the watch condition is now met (or has changed since last state in a way the user cares about); false otherwise",
    ),
  summary: z
    .string()
    .describe("One short paragraph explaining what's new. Sent to the user when triggered=true."),
  newState: z
    .string()
    .describe(
      "Concise snapshot of the current observation. Used as the reference state on the next check. Should capture the data the next run will compare against.",
    ),
});

export const reportWatcherResult = tool({
  description:
    "Report the result of this detection run. Call exactly once when you've gathered enough information. This terminates the watcher tick.",
  inputSchema: reportWatcherResultInputSchema,
  // Output is intentionally minimal — the executor reads the call's input
  // (via `result.steps`), not this return value.
  execute: ({ triggered, summary }) => {
    logger.debug({ triggered, summary }, "Tool: reportWatcherResult");
    return Promise.resolve({ ok: true });
  },
});
