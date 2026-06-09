import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { platformForChatId, type AdapterRegistry } from "../platform/registry";

/**
 * Shared driver for the unprompted self-review passes (routine self-review,
 * skill curation): enumerate the chats that own reviewable items, resolve each
 * chat's platform adapter from the registry so the pass can raise approval
 * bubbles unprompted, and isolate per-chat failures so one bad chat never
 * blocks the rest. `review` returns the number of proposals it raised.
 */
export async function runReviewForEachChat(opts: {
  /** Stable pass identifier, bound to every log line as `review`. */
  label: string;
  registry: AdapterRegistry;
  listChatIds: () => Promise<string[]>;
  review: (chatId: string, adapter: PlatformAdapter) => Promise<number>;
}): Promise<void> {
  const { label, registry, listChatIds, review } = opts;
  const chatIds = await listChatIds();
  if (chatIds.length === 0) return;

  for (const chatId of chatIds) {
    const adapter = registry.get(platformForChatId(chatId));
    if (!adapter) {
      logger.warn(
        { review: label, chatId },
        "Self-review: no adapter registered for chat — skipping",
      );
      continue;
    }
    try {
      const raised = await review(chatId, adapter);
      if (raised > 0) {
        logger.info({ review: label, chatId, raised }, "Self-review raised proposals");
      }
    } catch (error) {
      logger.error({ error, review: label, chatId }, "Self-review failed for chat");
    }
  }
}
