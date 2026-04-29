import { generateText, stepCountIs } from "ai";
import { getModel } from "../ai/provider";
import { assembleProactiveSystemPrompt, assembleMessages } from "../ai/context-assembler";
import { checkWeeklyMerge, checkMonthlyConsolidation } from "../memory/curator";
import { allTools, type ToolContext } from "../ai/tools/index";
import {
  getOrCreateSession,
  appendMessage,
  getRecentMessages,
  cleanupOldConversations,
  cleanupFiredReminders,
  cleanupOldSkillLogs,
  cleanupOldWatcherLogs,
  cleanupOldLocations,
  getNextProactiveAt,
  setNextProactiveAt,
} from "@mashiro/db";
import { config, logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";
import { extractResponseText, collectToolCalls, wasPhotoSent, sendSegmented } from "../ai/response";
import { trackUsage } from "../ai/token-tracker";
import { getModelName } from "../ai/provider";

const LLM_TIMEOUT_MS = 120_000; // 2 minutes

const timers = new Map<string, NodeJS.Timeout>();
let _adapter: PlatformAdapter | null = null;

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.random() * (maxMs - minMs);
}

const MIN_INTERVAL = 1.5 * 60 * 60_000; // 1.5 hours
const MAX_INTERVAL = 2.5 * 60 * 60_000; // 2.5 hours
const MIN_IDLE = 60 * 60_000; // 1 hour
const STARTUP_MIN = 30 * 60_000; // 30 min
const STARTUP_MAX = 60 * 60_000; // 1 hour
const CLEANUP_INTERVAL = 24 * 60 * 60_000; // 24 hours

let cleanupTimer: NodeJS.Timeout | null = null;

function getHourInTimezone(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: config.TIMEZONE,
    }).format(new Date()),
  );
}

function isActiveHour(): boolean {
  const hour = getHourInTimezone();
  return hour >= 9 || hour < 1;
}

function msUntilNextActive(): number {
  const now = new Date();
  const tz = config.TIMEZONE;

  const currentHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now),
  );
  const currentMinute = Number(
    new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: tz }).format(now),
  );
  const currentSecond = Number(
    new Intl.DateTimeFormat("en-US", { second: "numeric", timeZone: tz }).format(now),
  );

  // Calculate ms until 9:00:00 AM in the configured timezone
  const hoursUntil9 = currentHour < 9 ? 9 - currentHour : 24 - currentHour + 9;
  return hoursUntil9 * 60 * 60_000 - (currentMinute * 60_000 + currentSecond * 1000);
}

function scheduleNext(chatId: string, userId: string, delayMs?: number): void {
  const existing = timers.get(chatId);
  if (existing) clearTimeout(existing);

  const delay = delayMs ?? randomBetween(MIN_INTERVAL, MAX_INTERVAL);
  const nextAt = new Date(Date.now() + delay);

  // Persist so we survive restarts
  setNextProactiveAt(chatId, nextAt).catch((error) => {
    logger.error({ error, chatId }, "Failed to persist scheduler state");
  });

  const timeout = setTimeout(() => {
    timers.delete(chatId);
    fireProactive(chatId, userId).catch((error) => {
      logger.error({ error, chatId }, "Proactive fire failed");
      scheduleNext(chatId, userId);
    });
  }, delay);

  timers.set(chatId, timeout);
  logger.debug({ chatId, nextIn: Math.round(delay / 60_000) + "m" }, "Proactive timer scheduled");
}

async function fireProactive(chatId: string, userId: string): Promise<void> {
  if (!_adapter) return;

  // Check active hours — if outside, reschedule to next 9am + jitter
  if (!isActiveHour()) {
    const delay = msUntilNextActive() + randomBetween(0, 30 * 60_000);
    scheduleNext(chatId, userId, delay);
    logger.debug({ chatId }, "Outside active hours, rescheduled to morning");
    return;
  }

  // Check idle time — must be idle for at least MIN_IDLE
  const recent = await getRecentMessages(chatId, 1);
  if (recent.length > 0) {
    const elapsed = Date.now() - recent[0].timestamp.getTime();
    if (elapsed < MIN_IDLE) {
      // Reschedule for when idle threshold is met + small jitter
      const delay = MIN_IDLE - elapsed + randomBetween(0, 10 * 60_000);
      scheduleNext(chatId, userId, delay);
      logger.debug(
        { chatId, minsSince: Math.round(elapsed / 60_000) },
        "Chat still active, rescheduled",
      );
      return;
    }
  }

  // Generate and send
  try {
    await generateProactiveMessage(chatId, userId, _adapter);
  } catch (error) {
    logger.error({ error, chatId }, "Failed to send proactive message");
  }

  // Schedule next
  scheduleNext(chatId, userId);

  // Fire-and-forget memory consolidation checks
  checkWeeklyMerge().catch((error) => {
    logger.warn({ error }, "Weekly merge check failed during proactive cycle");
  });
  checkMonthlyConsolidation().catch((error) => {
    logger.warn({ error }, "Monthly consolidation check failed during proactive cycle");
  });
}

async function generateProactiveMessage(
  chatId: string,
  userId: string,
  adapter: PlatformAdapter,
): Promise<void> {
  logger.info({ chatId }, "Generating proactive message");

  const { conversation } = await getOrCreateSession(chatId, userId, "telegram");
  const sessionId = conversation.sessionId;

  const [systemPrompt, messages] = await Promise.all([
    assembleProactiveSystemPrompt(chatId, sessionId),
    assembleMessages(chatId),
  ]);

  // API requires conversation to end with a user message.
  // For proactive messages there's no real user input, so we add a
  // synthetic nudge that the system prompt will override.
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: "[Time has passed. Text him if you feel like it.]" });
  }

  const toolContext: ToolContext = { chatId, adapter, sessionId, userId };

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    tools: allTools(toolContext),
    stopWhen: stepCountIs(5),
    temperature: 0.7,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  // Track token usage
  trackUsage("proactive", getModelName(), result.usage, {
    chatId,
    sessionId,
    steps: result.steps.length,
  });

  // Extract response text from steps
  const responseText = result.text || extractResponseText(result.steps);

  if (!responseText) {
    logger.warn({ chatId }, "Proactive generation produced no text");
    return;
  }

  logger.info({ chatId, preview: responseText.slice(0, 120) }, "Proactive message generated");

  // Save to conversation history
  const toolCallData = collectToolCalls(result.steps);

  await appendMessage(conversation, {
    role: "assistant",
    content: responseText,
    toolCalls: toolCallData.length > 0 ? toolCallData : undefined,
    timestamp: new Date(),
  });

  // Send — skip if sendPhoto already delivered text as caption
  if (!wasPhotoSent(result.steps)) {
    await sendSegmented(adapter, chatId, responseText);
  }
}

async function runDailyCleanup(): Promise<void> {
  try {
    const [deletedReminders, deletedConvos, deletedLogs, deletedWatcherLogs, deletedLocations] =
      await Promise.all([
        cleanupFiredReminders(30),
        cleanupOldConversations(90),
        cleanupOldSkillLogs(90),
        cleanupOldWatcherLogs(90),
        cleanupOldLocations(90),
      ]);
    if (
      deletedReminders > 0 ||
      deletedConvos > 0 ||
      deletedLogs > 0 ||
      deletedWatcherLogs > 0 ||
      deletedLocations > 0
    ) {
      logger.info(
        { deletedReminders, deletedConvos, deletedLogs, deletedWatcherLogs, deletedLocations },
        "Daily cleanup complete",
      );
    }
  } catch (error) {
    logger.error({ error }, "Daily cleanup failed");
  }
}

export function resetTimer(chatId: string): void {
  if (!_adapter) return;
  // For Telegram private chats, chatId equals userId
  scheduleNext(chatId, chatId);
}

export function triggerLocationProactive(chatId: string): void {
  if (!_adapter) return;
  const delay = config.LOCATION_PROACTIVE_DELAY_MS + randomBetween(0, 5 * 60_000);
  logger.debug(
    { chatId, delayMin: Math.round(delay / 60_000) },
    "Location-triggered proactive message scheduled",
  );
  scheduleNext(chatId, chatId, delay);
}

export function startProactiveScheduler(adapter: PlatformAdapter): () => void {
  _adapter = adapter;

  for (const numericUserId of config.ALLOWED_USER_IDS) {
    const chatId = String(numericUserId);
    const userId = String(numericUserId);

    // Restore persisted timer, falling back to last-message heuristic
    getNextProactiveAt(chatId)
      .then(async (savedAt) => {
        if (savedAt) {
          const remaining = savedAt.getTime() - Date.now();
          if (remaining > 0) {
            // Timer hasn't expired yet — resume exactly where we left off
            scheduleNext(chatId, userId, remaining);
            return;
          }
          // Timer expired while we were down — fire soon but not instantly
          scheduleNext(chatId, userId, randomBetween(STARTUP_MIN, STARTUP_MAX));
          return;
        }

        // No saved state — fall back to last message heuristic
        const recent = await getRecentMessages(chatId, 1);
        let delay: number;
        if (recent.length === 0) {
          delay = randomBetween(STARTUP_MIN, STARTUP_MAX);
        } else {
          const elapsed = Date.now() - recent[0].timestamp.getTime();
          const remaining = randomBetween(MIN_INTERVAL, MAX_INTERVAL) - elapsed;
          delay = remaining > 0 ? remaining : randomBetween(STARTUP_MIN, STARTUP_MAX);
        }
        scheduleNext(chatId, userId, delay);
      })
      .catch((error) => {
        logger.error({ error, chatId }, "Failed to init proactive timer");
        scheduleNext(chatId, userId, randomBetween(STARTUP_MIN, STARTUP_MAX));
      });
  }

  // Schedule daily cleanup
  cleanupTimer = setInterval(() => {
    runDailyCleanup().catch((error) => {
      logger.error({ error }, "Cleanup interval failed");
    });
  }, CLEANUP_INTERVAL);

  // Run cleanup once on startup (after a short delay)
  setTimeout(() => {
    runDailyCleanup().catch((error) => {
      logger.error({ error }, "Startup cleanup failed");
    });
  }, 60_000);

  logger.info({ chats: config.ALLOWED_USER_IDS.length }, "Proactive scheduler started");

  return () => {
    for (const timeout of timers.values()) {
      clearTimeout(timeout);
    }
    timers.clear();
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    _adapter = null;
    logger.info("Proactive scheduler stopped");
  };
}
