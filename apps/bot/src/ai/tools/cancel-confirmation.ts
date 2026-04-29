import { tool } from "ai";
import { z } from "zod";
import { getPendingConfirmation, resolvePendingConfirmation } from "@mashiro/db";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { appendConfirmationResolution } from "../../services/confirmation-events";

/**
 * LLM-facing tool to cancel a pending confirmation. Used when Goshujin-sama
 * changes his mind via chat ("nvm, don't send that") instead of tapping
 * Deny on the prompt bubble. Atomically transitions the row to "cancelled",
 * edits the prompt bubble in place, and appends a bracketed event so the
 * conversation history reflects the cancellation.
 *
 * Idempotent on already-resolved rows — returns success: false with the
 * existing status, lets Mashiro acknowledge gracefully.
 */
export function createCancelConfirmationTool(
  chatId: string,
  adapter: PlatformAdapter,
  userId?: string,
) {
  return tool({
    description:
      "Cancel a pending approval request that you previously raised via requestConfirmation. Use this when Goshujin-sama changes his mind in chat instead of tapping the Deny button. Pass the confirmationId from the pending list in your context.",
    inputSchema: z.object({
      confirmationId: z.string().min(1).describe("The id of the pending confirmation to cancel."),
      reason: z
        .string()
        .optional()
        .describe(
          "Optional short reason — surfaced in the cancellation event so you can reference it later.",
        ),
    }),
    execute: async ({ confirmationId, reason }) => {
      try {
        const row = await getPendingConfirmation(confirmationId);
        if (!row) {
          return { success: false, reason: "confirmation not found" };
        }
        if (row.chatId !== chatId) {
          return { success: false, reason: "confirmation belongs to a different chat" };
        }
        if (row.status !== "pending") {
          return { success: false, reason: `already ${row.status}` };
        }

        const resolved = await resolvePendingConfirmation(confirmationId, "cancelled", reason);
        if (!resolved) {
          return { success: false, reason: "confirmation was just resolved by another path" };
        }

        if (row.promptMessageId) {
          await adapter.editConfirmationPrompt(
            row.chatId,
            row.promptMessageId,
            `✗ Cancelled · ${row.summary}${reason ? `\n${reason}` : ""}`,
          );
        }

        // userId may be missing if a cron-triggered skill calls this tool
        // (no active user driving the turn). Fall back to chatId — for
        // private Telegram chats they're numerically equal, so session
        // creation still keys correctly.
        await appendConfirmationResolution(row.chatId, userId ?? row.chatId, {
          summary: row.summary,
          verdict: "cancelled",
          resultText: reason,
        });

        logger.info({ confirmationId, chatId, reason }, "Tool: cancelConfirmation");
        return { success: true, confirmationId };
      } catch (error) {
        logger.error({ error, confirmationId }, "Tool: cancelConfirmation failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to cancel confirmation",
        };
      }
    },
  });
}
