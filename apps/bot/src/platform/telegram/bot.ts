import { Bot } from "grammy";
import { config, logger } from "@mashiro/shared";
import { clearConversation } from "@mashiro/db";
import { TelegramAdapter } from "./adapter";
import { handleMessage } from "../../ai/generate";
import { resetTimer, triggerLocationProactive } from "../../scheduler/proactive";
import { processLocation } from "../../services/location";

// Simple in-memory rate limiter
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 15; // max messages per window

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// Periodic eviction of stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of rateLimitMap) {
    if (timestamps.every((t) => now - t >= RATE_LIMIT_WINDOW)) {
      rateLimitMap.delete(userId);
    }
  }
}, RATE_LIMIT_WINDOW).unref();

let _adapter: TelegramAdapter | null = null;

export function getAdapter(): TelegramAdapter {
  if (!_adapter) throw new Error("Bot not created yet");
  return _adapter;
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  const adapter = new TelegramAdapter(bot);
  _adapter = adapter;

  // Allowlist middleware
  bot.use(async (ctx, next) => {
    if (config.ALLOWED_USER_IDS.length === 0) {
      return next();
    }
    const userId = ctx.from?.id;
    if (userId && config.ALLOWED_USER_IDS.includes(userId)) {
      return next();
    }
    logger.warn({ userId }, "Unauthorized user blocked");
  });

  bot.command("clear", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await clearConversation(chatId);
    logger.info({ chatId }, "Conversation cleared via /clear command");
    await ctx.reply("Context cleared — starting fresh.");
  });

  bot.on("message:photo", async (ctx) => {
    const incoming = await adapter.normalizePhoto(ctx);
    if (!incoming) return;

    if (isRateLimited(incoming.userId)) {
      logger.warn({ userId: incoming.userId }, "Rate limited");
      await ctx.reply("slow down babe, i can't keep up lol");
      return;
    }

    logger.info({ userId: incoming.userId, hasCaption: !!ctx.message?.caption }, "Incoming photo");

    try {
      await ctx.replyWithChatAction("typing");
      await handleMessage(incoming, adapter);
      resetTimer(incoming.chatId);
    } catch (error) {
      logger.error({ error }, "Error handling photo message");
      await ctx.reply("sorry something went wrong, give me a sec 💭");
    }
  });

  bot.on("message:text", async (ctx) => {
    const incoming = adapter.normalize(ctx);
    if (!incoming) return;

    // Rate limiting
    if (isRateLimited(incoming.userId)) {
      logger.warn({ userId: incoming.userId }, "Rate limited");
      await ctx.reply("slow down babe, i can't keep up lol");
      return;
    }

    logger.info({ userId: incoming.userId, text: incoming.text.slice(0, 50) }, "Incoming message");

    try {
      await ctx.replyWithChatAction("typing");
      await handleMessage(incoming, adapter);
      resetTimer(incoming.chatId);
    } catch (error) {
      logger.error({ error }, "Error handling message");
      await ctx.reply("sorry something went wrong, give me a sec 💭");
    }
  });

  if (config.LOCATION_ENABLED) {
    bot.on("message:location", async (ctx) => {
      const incoming = adapter.normalizeLocation(ctx);
      if (!incoming || !incoming.location) return;

      if (isRateLimited(incoming.userId)) {
        logger.warn({ userId: incoming.userId }, "Rate limited");
        return;
      }

      logger.info(
        {
          userId: incoming.userId,
          lat: incoming.location.latitude,
          lng: incoming.location.longitude,
          live: !!incoming.location.livePeriod,
        },
        "Incoming location",
      );

      try {
        const event = await processLocation(
          incoming.chatId,
          incoming.location.latitude,
          incoming.location.longitude,
          {
            accuracy: incoming.location.accuracy,
            heading: incoming.location.heading,
            isLive: !!incoming.location.livePeriod,
          },
        );

        // Run full AI pipeline so Mashiro can react
        await ctx.replyWithChatAction("typing");
        await handleMessage(incoming, adapter);
        resetTimer(incoming.chatId);

        if (event) {
          triggerLocationProactive(incoming.chatId);
        }
      } catch (error) {
        logger.error({ error }, "Error handling location message");
      }
    });

    bot.on("edited_message:location", async (ctx) => {
      const incoming = adapter.normalizeLocationEdit(ctx);
      if (!incoming || !incoming.location) return;

      logger.debug(
        {
          chatId: incoming.chatId,
          lat: incoming.location.latitude,
          lng: incoming.location.longitude,
        },
        "Live location update",
      );

      try {
        const event = await processLocation(
          incoming.chatId,
          incoming.location.latitude,
          incoming.location.longitude,
          {
            accuracy: incoming.location.accuracy,
            heading: incoming.location.heading,
            isLive: true,
          },
        );

        if (event) {
          triggerLocationProactive(incoming.chatId);
        }
      } catch (error) {
        logger.error({ error }, "Error handling live location update");
      }
    });
  }

  bot.catch((err) => {
    logger.error({ error: err.error }, "Bot error");
  });

  return bot;
}

export function startBot(bot: Bot): void {
  logger.info("Starting Telegram bot...");
  bot.start().catch((error) => {
    logger.fatal({ error }, "Bot polling failed");
    process.exit(1);
  });
  logger.info("Telegram bot polling initiated");
}
