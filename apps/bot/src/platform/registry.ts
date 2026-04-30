import type { PlatformAdapter } from "@mashiro/shared";

/**
 * Holds a `PlatformAdapter` per platform string. Schedulers and resolution
 * paths look up the right adapter for a given chatId by deriving the
 * platform from the chatId via `platformForChatId`.
 *
 * Telegram chatIds are bare numeric strings; iMessage chatIds are stored
 * with an `imessage:` prefix. The prefix scheme means existing Telegram
 * data needs no migration — a numeric string can never collide with an
 * `imessage:`-prefixed string.
 */
export class AdapterRegistry {
  private adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: string): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  /**
   * Lookup that throws if the requested platform isn't registered. Use this
   * at sites where missing the adapter is unrecoverable (e.g. a scheduler
   * trying to fire on a platform that's not configured — better to surface
   * the misconfiguration than silently drop the message).
   */
  require(platform: string): PlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for platform "${platform}"`);
    }
    return adapter;
  }

  has(platform: string): boolean {
    return this.adapters.has(platform);
  }

  platforms(): string[] {
    return [...this.adapters.keys()];
  }
}

/**
 * Derive the platform name from a stored chatId. iMessage chatIds carry an
 * explicit `imessage:` prefix; everything else is Telegram (the only other
 * platform today, and Telegram chatIds are always plain integer strings
 * that can't accidentally start with "imessage:").
 */
export function platformForChatId(chatId: string): string {
  if (chatId.startsWith("imessage:")) return "imessage";
  return "telegram";
}

/** Build the canonical chatId for an iMessage chatGuid. */
export function imessageChatId(chatGuid: string): string {
  return `imessage:${chatGuid}`;
}
