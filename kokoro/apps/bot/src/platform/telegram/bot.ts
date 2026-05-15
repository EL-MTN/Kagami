import { Bot } from "grammy";
import { config, logger, newTraceContext, runWithTrace } from "@kokoro/shared";
import {
  clearConversation,
  getPendingConfirmation,
  resolvePendingConfirmation,
  attachResultText,
} from "@kokoro/db";
import { TelegramAdapter } from "./adapter";
import { handleMessage } from "../../ai/generate";
import { generateAcknowledgment } from "../../ai/acknowledge";
import { resetTimer, triggerLocationProactive } from "../../scheduler/proactive";
import { processLocation } from "../../services/location";
import { dispatchGatedAction } from "../../services/gated-actions";
import { appendConfirmationResolution } from "../../services/confirmation-events";

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

  // Trace context first: every Telegram update becomes the root of its own
  // trace, so logs from handleMessage, AI tools, Kioku/Kizuna fetches, and
  // schedulers triggered inside the same update share a traceId.
  bot.use(async (_ctx, next) => {
    await runWithTrace(newTraceContext(), () => next());
  });

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

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const match = /^confirm:([a-f0-9]{24}):(approve|deny)$/.exec(data);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }
    const [, confirmationId, verdict] = match;
    const userId = String(ctx.from.id);
    // For non-inline callback queries (the only kind this bot handles),
    // ctx.chat is always populated. Reject defensively if it's missing
    // rather than silently bypassing the chat-scope ownership check.
    if (!ctx.chat) {
      logger.warn({ confirmationId, userId }, "Callback query without chat context");
      await ctx.answerCallbackQuery({ text: "Invalid context" });
      return;
    }
    const chatIdFromCtx = String(ctx.chat.id);

    try {
      const row = await getPendingConfirmation(confirmationId);
      if (!row || row.chatId !== chatIdFromCtx) {
        await ctx.answerCallbackQuery({ text: "Confirmation not found" });
        return;
      }
      if (row.status !== "pending") {
        await ctx.answerCallbackQuery({ text: `Already ${row.status}` });
        return;
      }
      // promptMessageId should always be set (sendConfirmationPrompt stored
      // it after the row was created). Fall back to the message the
      // callback originated from if not. If neither is available we have
      // no way to edit the prompt — bail rather than passing "" → 0 to
      // editMessageText, which would be a silent Telegram 400.
      const promptMessageId =
        row.promptMessageId ??
        (ctx.callbackQuery.message ? String(ctx.callbackQuery.message.message_id) : null);
      if (!promptMessageId) {
        logger.warn(
          { confirmationId, chatId: row.chatId },
          "Cannot resolve confirmation: no prompt message id",
        );
        await ctx.answerCallbackQuery({ text: "Prompt missing" });
        return;
      }

      if (row.expiresAt.getTime() < Date.now()) {
        // Same race-fix discipline as the approve/deny path below: a
        // concurrent click could already have transitioned the row (e.g.
        // an approve click that landed before the row's expiry tick).
        // If our atomic transition fails, bow out so we don't overwrite
        // their bubble edit with "⏱ Expired".
        const resolved = await resolvePendingConfirmation(confirmationId, "expired");
        if (!resolved) {
          await ctx.answerCallbackQuery({ text: "Already resolved" });
          return;
        }
        await adapter.editConfirmationPrompt(
          row.chatId,
          promptMessageId,
          `⏱ Expired · ${row.summary}`,
        );
        await ctx.answerCallbackQuery({ text: "Expired" });
        return;
      }

      // RACE FIX: transition to a terminal status BEFORE doing any work that
      // could be double-fired by a concurrent click. If the second click
      // reaches this point first, the second `resolvePendingConfirmation`
      // returns null and we bow out cleanly.
      const targetVerdict = verdict === "deny" ? "denied" : "approved";
      const resolved = await resolvePendingConfirmation(confirmationId, targetVerdict);
      if (!resolved) {
        await ctx.answerCallbackQuery({ text: "Already resolved" });
        return;
      }

      // Acknowledge immediately so the Telegram button spinner doesn't sit
      // through dispatch (especially relevant for browse:agent which can
      // run for tens of seconds). We post the actual result via bubble edit
      // + acknowledgment turn afterward.
      await ctx.answerCallbackQuery({
        text: targetVerdict === "denied" ? "Denied" : "Working…",
      });

      if (targetVerdict === "denied") {
        await adapter.editConfirmationPrompt(
          row.chatId,
          promptMessageId,
          `✗ Denied · ${row.summary}`,
        );
        await appendConfirmationResolution(row.chatId, userId, {
          summary: row.summary,
          verdict: "denied",
        });
        logger.info({ confirmationId, chatId: row.chatId }, "Confirmation denied");
      } else {
        const dispatch = await dispatchGatedAction(row.action.tool, row.action.args);
        await attachResultText(confirmationId, dispatch.summary);

        const verdictMark = dispatch.success ? "✓ Approved" : "⚠ Approved · failed";
        await adapter.editConfirmationPrompt(
          row.chatId,
          promptMessageId,
          `${verdictMark} · ${row.summary}\n${dispatch.summary}`,
        );
        await appendConfirmationResolution(row.chatId, userId, {
          summary: row.summary,
          verdict: "approved",
          success: dispatch.success,
          resultText: dispatch.summary,
        });
        logger.info(
          { confirmationId, chatId: row.chatId, success: dispatch.success },
          "Confirmation approved + dispatched",
        );
      }

      // Fire-and-forget acknowledgment turn — Mashiro speaks the result in
      // character. Errors here don't roll back the dispatch; they're just
      // a missed in-character reply. The bracketed event in conversation
      // history still surfaces the resolution on the next user turn.
      generateAcknowledgment(row.chatId, userId, adapter).catch((error) => {
        logger.warn({ err: error, confirmationId }, "Acknowledgment turn failed");
      });
    } catch (error) {
      logger.error({ err: error, confirmationId }, "Callback handler error");
      try {
        await ctx.answerCallbackQuery({ text: "Error" });
      } catch {
        // ignore
      }
    }
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
      logger.error(
        { err: error, userId: incoming.userId, chatId: incoming.chatId },
        "Error handling photo message",
      );
      await ctx.reply("sorry something went wrong, give me a sec 💭");
    }
  });

  // Voice notes (recorded in Telegram) and audio files (forwarded) both
  // route through the same STT pipeline. The adapter populates audio
  // fields on IncomingMessage; handleMessage does the transcription and
  // either prefixes the transcript with "[voice]" or surfaces a
  // placeholder when STT_PROVIDER is unset / fails / hits the cap.
  bot.on("message:voice", async (ctx) => {
    const incoming = await adapter.normalizeVoice(ctx);
    if (!incoming) return;

    if (isRateLimited(incoming.userId)) {
      logger.warn({ userId: incoming.userId }, "Rate limited");
      await ctx.reply("slow down babe, i can't keep up lol");
      return;
    }

    logger.info(
      {
        userId: incoming.userId,
        durationSeconds: incoming.audioDurationSeconds,
        hasBuffer: !!incoming.audioBuffer,
      },
      "Incoming voice note",
    );

    try {
      await ctx.replyWithChatAction("typing");
      await handleMessage(incoming, adapter);
      resetTimer(incoming.chatId);
    } catch (error) {
      logger.error(
        { err: error, userId: incoming.userId, chatId: incoming.chatId },
        "Error handling voice message",
      );
      await ctx.reply("sorry something went wrong, give me a sec 💭");
    }
  });

  bot.on("message:audio", async (ctx) => {
    const incoming = await adapter.normalizeAudio(ctx);
    if (!incoming) return;

    if (isRateLimited(incoming.userId)) {
      logger.warn({ userId: incoming.userId }, "Rate limited");
      await ctx.reply("slow down babe, i can't keep up lol");
      return;
    }

    logger.info(
      {
        userId: incoming.userId,
        durationSeconds: incoming.audioDurationSeconds,
        hasBuffer: !!incoming.audioBuffer,
      },
      "Incoming audio file",
    );

    try {
      await ctx.replyWithChatAction("typing");
      await handleMessage(incoming, adapter);
      resetTimer(incoming.chatId);
    } catch (error) {
      logger.error(
        { err: error, userId: incoming.userId, chatId: incoming.chatId },
        "Error handling audio message",
      );
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
      logger.error(
        { err: error, userId: incoming.userId, chatId: incoming.chatId },
        "Error handling message",
      );
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
          triggerLocationProactive(incoming.chatId, incoming.userId);
        }
      } catch (error) {
        logger.error(
          { err: error, userId: incoming.userId, chatId: incoming.chatId },
          "Error handling location message",
        );
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
          triggerLocationProactive(incoming.chatId, incoming.userId);
        }
      } catch (error) {
        logger.error(
          { err: error, userId: incoming.userId, chatId: incoming.chatId },
          "Error handling live location update",
        );
      }
    });
  }

  bot.catch((err) => {
    logger.error({ err: err.error }, "Bot error");
  });

  return bot;
}

export function startBot(bot: Bot): void {
  logger.info("Starting Telegram bot...");
  bot.start().catch((error) => {
    logger.fatal({ err: error }, "Bot polling failed");
    process.exit(1);
  });
  logger.info("Telegram bot polling initiated");
}
