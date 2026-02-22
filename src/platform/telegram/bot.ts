import { Bot } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { TelegramAdapter } from "./adapter.js";
import { handleMessage } from "../../ai/generate.js";
import { resetTimer } from "../../scheduler/proactive.js";

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

  bot.on("message:text", async (ctx) => {
    const incoming = adapter.normalize(ctx);
    if (!incoming) return;

    // Rate limiting
    if (isRateLimited(incoming.userId)) {
      logger.warn({ userId: incoming.userId }, "Rate limited");
      await ctx.reply("slow down babe, i can't keep up lol");
      return;
    }

    logger.info(
      { userId: incoming.userId, text: incoming.text.slice(0, 50) },
      "Incoming message",
    );

    try {
      await ctx.replyWithChatAction("typing");
      await handleMessage(incoming, adapter);
      resetTimer(incoming.chatId);
    } catch (error) {
      logger.error({ error }, "Error handling message");
      await ctx.reply("sorry something went wrong, give me a sec 💭");
    }
  });

  bot.catch((err) => {
    logger.error({ error: err.error }, "Bot error");
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<void> {
  logger.info("Starting Telegram bot...");
  bot.start();
  logger.info("Telegram bot started");
}
