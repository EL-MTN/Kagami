import { appendMessage, getOrCreateSession } from "@mashiro/db";
import { logger } from "@mashiro/shared";

export interface ConfirmationResolutionEvent {
  summary: string;
  verdict: "approved" | "denied" | "cancelled";
  success?: boolean;
  resultText?: string;
}

/**
 * Append a synthetic event into the active conversation so the LLM sees the
 * resolution on its next turn and can reference it organically. We use
 * role "user" with a bracketed marker because `assembleMessages` only
 * specially reconstructs user vs. assistant — a "system" role here would
 * silently round-trip as assistant content. The bracketed prefix is the
 * in-band signal Mashiro reads.
 *
 * Caller passes `userId` because we may need to materialize a session if
 * the chat has no active conversation (rare but possible — e.g., callback
 * resolves a confirmation in a chat that hasn't messaged in over an hour).
 */
export async function appendConfirmationResolution(
  chatId: string,
  userId: string,
  event: ConfirmationResolutionEvent,
): Promise<void> {
  try {
    const { conversation } = await getOrCreateSession(chatId, userId, "telegram");
    const tail =
      event.verdict === "denied"
        ? `[goshujin-sama denied: "${event.summary}"]`
        : event.verdict === "cancelled"
          ? `[mashiro cancelled pending request: "${event.summary}"${
              event.resultText ? ` (${event.resultText})` : ""
            }]`
          : `[goshujin-sama approved: "${event.summary}" — ${
              event.success ? "done" : "action failed"
            }${event.resultText ? `: ${event.resultText}` : ""}]`;
    await appendMessage(conversation, {
      role: "user",
      content: tail,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.warn({ error, chatId }, "Failed to append confirmation resolution event");
  }
}
