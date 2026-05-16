import { tool } from "ai";
import { z } from "zod";
import {
  createPendingConfirmation,
  setPromptMessageId,
  getPendingConfirmation,
  resolvePendingConfirmation,
} from "@kokoro/db";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { GATED_TOOL_NAMES, isGatedTool } from "../../services/gated-actions";
import { appendConfirmationResolution } from "../../services/confirmation-events";

// ─── requestConfirmation ─────────────────────────────────────────────────────

/**
 * Builds the LLM-facing `requestConfirmation` tool. The tool persists a
 * pending row, posts a Telegram message with [Approve][Deny] buttons via the
 * adapter, and returns `{ pending: true, confirmationId }`. The action is
 * NOT executed here — it executes when the user resolves the confirmation,
 * which the platform's callback handler routes through `dispatchGatedAction`.
 *
 * The tool is intentionally narrow: it only accepts gated tool names as the
 * action target, so the LLM can't smuggle arbitrary side effects through it.
 */
export function createRequestConfirmationTool(
  chatId: string,
  adapter: PlatformAdapter,
  origin: "conversation" | "routine" = "conversation",
  originRef?: string,
) {
  const gatedToolEnum = z.enum(GATED_TOOL_NAMES);

  return tool({
    description:
      "Ask Goshujin-sama to approve an externally-visible or irreversible action before it runs. Use this for any action you wouldn't want to misfire — sending email to anyone other than yourself, deleting calendar events, browser-driven purchases. The user gets a tap-to-approve message; once they approve, the action runs and the result lands back in this chat. Returns immediately with { pending: true } — stop and wait, don't try the action again in the same turn.",
    inputSchema: z.object({
      summary: z
        .string()
        .min(1)
        .max(400)
        .describe(
          "One short sentence shown to Goshujin-sama on the approval prompt. Be specific: 'send email to alice@x.com about the contract' beats 'send email'.",
        ),
      action: z
        .object({
          tool: gatedToolEnum.describe(
            "Name of the gated tool to invoke after approval. Must match the tool's argument schema exactly.",
          ),
          args: z
            .record(z.string(), z.unknown())
            .describe("Arguments for the gated tool, validated server-side at dispatch time."),
        })
        .describe("The action to run if approved."),
    }),
    execute: async ({ summary, action }) => {
      // Zod enum already constrains `action.tool` to GATED_TOOL_NAMES; the
      // runtime guard exists only as defense-in-depth against future schema
      // drift and so the import is meaningfully consumed.
      if (!isGatedTool(action.tool)) {
        return { pending: false, success: false, reason: "tool is not approval-gated" };
      }

      try {
        const row = await createPendingConfirmation({
          chatId,
          summary,
          action: { tool: action.tool, args: action.args },
          origin,
          originRef,
        });
        const id = String(row._id);

        const promptText = `Approve action?\n\n${summary}`;
        const messageId = await adapter.sendConfirmationPrompt(chatId, promptText, id);
        if (messageId) {
          await setPromptMessageId(id, messageId);
        }

        logger.debug(
          { confirmationId: id, tool: action.tool, origin },
          "Tool: requestConfirmation",
        );
        return {
          pending: true,
          confirmationId: id,
          message:
            "Approval prompt sent. Stop here — don't call the action again in this turn. Goshujin-sama will tap Approve or Deny.",
        };
      } catch (error) {
        logger.error({ error: error }, "Tool: requestConfirmation failed");
        return {
          pending: false,
          success: false,
          reason: error instanceof Error ? error.message : "Failed to create confirmation",
        };
      }
    },
  });
}

// ─── cancelConfirmation ──────────────────────────────────────────────────────

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

        // userId may be missing if a cron-triggered routine calls this tool
        // (no active user driving the turn). Fall back to chatId — for
        // private Telegram chats they're numerically equal, so session
        // creation still keys correctly.
        await appendConfirmationResolution(row.chatId, userId ?? row.chatId, {
          summary: row.summary,
          verdict: "cancelled",
          resultText: reason,
        });

        logger.debug({ confirmationId, chatId, reason }, "Tool: cancelConfirmation");
        return { success: true, confirmationId };
      } catch (error) {
        logger.error({ error: error, confirmationId }, "Tool: cancelConfirmation failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Failed to cancel confirmation",
        };
      }
    },
  });
}
