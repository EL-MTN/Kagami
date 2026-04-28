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
} from "@mashiro/db";
import { config, logger, computeNextRunAt, validateCronAndDefaults } from "@mashiro/shared";

const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" });

export function createManageWatchersTool(chatId: string) {
  return tool({
    description:
      "Manage watchers — scheduled detection jobs that monitor for change and notify Goshujin-sama only when a condition is met (price drops, listing matches, inbox events, etc.). Watchers are read-only by design: they observe and report. Create, list, update, delete, enable, or disable watchers.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "update", "delete", "enable", "disable"]),
      watcherId: z
        .string()
        .optional()
        .describe("Watcher ID (required for update/delete/enable/disable)"),
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
    }),
    execute: async ({ action, watcherId, name, description, prompt, cronSchedule, expiresAt }) => {
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
            // browse or email. Warn so misconfigured deployments surface it.
            if (!config.BROWSER_ENABLED && !config.GOOGLE_OAUTH_CLIENT_ID) {
              logger.warn(
                { chatId, name },
                "Creating watcher with no external observation tools (BROWSER_ENABLED and GOOGLE_OAUTH_CLIENT_ID both unset). Watcher will only see memory.",
              );
            }

            logger.info({ chatId, name, cronSchedule }, "Tool: manageWatchers (create)");

            const nextRunAt = computeNextRunAt(cronSchedule);
            const expires = expiresAt ? new Date(expiresAt) : defaultExpiresAt();

            const watcher = await createWatcher(chatId, {
              name,
              description,
              prompt,
              cronSchedule,
              nextRunAt,
              expiresAt: expires,
            });

            return {
              success: true,
              watcherId: watcher._id,
              name,
              description,
              cronSchedule,
              nextRunAt: nextRunAt.toISOString(),
              expiresAt: expires.toISOString(),
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
