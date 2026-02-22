import { generateText } from "ai";
import { getModel } from "../ai/provider.js";
import { assembleProactiveSystemPrompt, assembleMessages } from "../ai/context-assembler.js";
import { allTools, type ToolContext } from "../ai/tools/index.js";
import {
  getOrCreateConversation,
  appendMessage,
  getRecentMessages,
} from "../db/models/conversation.js";
import { getNextProactiveAt, setNextProactiveAt } from "../db/models/scheduler-state.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { PlatformAdapter } from "../platform/types.js";

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

function isActiveHour(): boolean {
  const hour = new Date().getHours();
  return hour >= 9 || hour < 1;
}

function msUntilNextActive(): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function scheduleNext(chatId: string, delayMs?: number): void {
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
    fireProactive(chatId).catch((error) => {
      logger.error({ error, chatId }, "Proactive fire failed");
      scheduleNext(chatId);
    });
  }, delay);

  timers.set(chatId, timeout);
  logger.debug({ chatId, nextIn: Math.round(delay / 60_000) + "m" }, "Proactive timer scheduled");
}

async function fireProactive(chatId: string): Promise<void> {
  if (!_adapter) return;

  // Check active hours — if outside, reschedule to next 9am + jitter
  if (!isActiveHour()) {
    const delay = msUntilNextActive() + randomBetween(0, 30 * 60_000);
    scheduleNext(chatId, delay);
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
      scheduleNext(chatId, delay);
      logger.debug(
        { chatId, minsSince: Math.round(elapsed / 60_000) },
        "Chat still active, rescheduled",
      );
      return;
    }
  }

  // Generate and send
  try {
    await generateProactiveMessage(chatId, _adapter);
  } catch (error) {
    logger.error({ error, chatId }, "Failed to send proactive message");
  }

  // Schedule next
  scheduleNext(chatId);
}

async function generateProactiveMessage(chatId: string, adapter: PlatformAdapter): Promise<void> {
  logger.info({ chatId }, "Generating proactive message");

  const [systemPrompt, messages] = await Promise.all([
    assembleProactiveSystemPrompt(),
    assembleMessages(chatId),
  ]);

  // API requires conversation to end with a user message.
  // For proactive messages there's no real user input, so we add a
  // synthetic nudge that the system prompt will override.
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: "[Time has passed. Text him if you feel like it.]" });
  }

  const toolContext: ToolContext = { chatId, adapter };

  const result = await generateText({
    model: getModel(),
    system: systemPrompt,
    messages,
    tools: allTools(toolContext),
    maxSteps: 5,
    temperature: 0.7,
  });

  // Extract response text from steps
  let responseText = result.text;
  if (!responseText) {
    for (let i = result.steps.length - 1; i >= 0; i--) {
      if (result.steps[i].text) {
        responseText = result.steps[i].text;
        break;
      }
    }
  }

  if (!responseText) {
    logger.warn({ chatId }, "Proactive generation produced no text");
    return;
  }

  logger.info({ chatId, preview: responseText.slice(0, 120) }, "Proactive message generated");

  // Save to conversation history
  const conversation = await getOrCreateConversation(chatId, chatId, "telegram");

  const toolCalls = result.steps.flatMap((step) => {
    return (step.toolCalls || []).map((tc) => {
      const tr = step.toolResults?.find((r) => r.toolName === tc.toolName);
      return {
        toolName: tc.toolName,
        args: tc.args as Record<string, unknown>,
        result: tr ? JSON.stringify(tr.result) : undefined,
      };
    });
  });

  await appendMessage(conversation, {
    role: "assistant",
    content: responseText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: new Date(),
  });

  // Send — skip if sendPhoto already delivered text as caption
  const photoSent = result.steps.some((step) =>
    step.toolResults?.some(
      (tr) => tr.toolName === "sendPhoto" && (tr.result as { sent?: boolean })?.sent,
    ),
  );

  if (!photoSent) {
    const segments = responseText.split("\n\n").filter((s) => s.trim());
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        const words = segments[i].split(/\s+/).length;
        const baseDelay = (words / 100) * 60_000;
        const delay = Math.min(Math.max(baseDelay * (0.8 + Math.random() * 0.4), 500), 4000);
        await new Promise((r) => setTimeout(r, delay));
      }
      await adapter.sendText(chatId, segments[i]);
    }
  }
}

export function resetTimer(chatId: string): void {
  if (!_adapter) return;
  scheduleNext(chatId);
}

export function startProactiveScheduler(adapter: PlatformAdapter): () => void {
  _adapter = adapter;

  for (const userId of config.ALLOWED_USER_IDS) {
    const chatId = String(userId);

    // Restore persisted timer, falling back to last-message heuristic
    getNextProactiveAt(chatId)
      .then(async (savedAt) => {
        if (savedAt) {
          const remaining = savedAt.getTime() - Date.now();
          if (remaining > 0) {
            // Timer hasn't expired yet — resume exactly where we left off
            scheduleNext(chatId, remaining);
            return;
          }
          // Timer expired while we were down — fire soon but not instantly
          scheduleNext(chatId, randomBetween(STARTUP_MIN, STARTUP_MAX));
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
        scheduleNext(chatId, delay);
      })
      .catch((error) => {
        logger.error({ error, chatId }, "Failed to init proactive timer");
        scheduleNext(chatId, randomBetween(STARTUP_MIN, STARTUP_MAX));
      });
  }

  logger.info({ chats: config.ALLOWED_USER_IDS.length }, "Proactive scheduler started");

  return () => {
    for (const timeout of timers.values()) {
      clearTimeout(timeout);
    }
    timers.clear();
    _adapter = null;
    logger.info("Proactive scheduler stopped");
  };
}
