import fs from "node:fs/promises";
import path from "node:path";
import { format, formatDistanceToNow } from "date-fns";
import {
  getRecentMessages,
  readImage,
  listRemindersForChat,
  getRecentlyFiredReminders,
  getLatestLocation,
  listRoutinesForChat,
  listPendingConfirmations,
} from "@kokoro/db";
import { DATETIME_CONTEXT, moodForTimeOfDay, timeOfDayFor } from "./prompts";
import { config, logger, parseMarkdown } from "@kokoro/shared";
import type { ModelMessage, UserContent, ToolContent } from "ai";

const contextFileCache = new Map<string, { mtimeMs: number; content: string }>();
const missingContextFileWarned = new Set<string>();

async function readContextFile(relativePath: string): Promise<string | null> {
  const absPath = path.join(config.CONTEXT_PATH, relativePath);
  try {
    const stat = await fs.stat(absPath);
    const cached = contextFileCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const raw = await fs.readFile(absPath, "utf-8");
    const content = parseMarkdown(raw).content;
    contextFileCache.set(absPath, { mtimeMs: stat.mtimeMs, content });
    missingContextFileWarned.delete(absPath);
    return content;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!missingContextFileWarned.has(absPath)) {
        missingContextFileWarned.add(absPath);
        logger.warn(
          { path: absPath },
          "Context file missing — section will be omitted from prompt",
        );
      }
      return null;
    }
    throw error;
  }
}

export async function readInstruction(name: string): Promise<string | null> {
  return readContextFile(`instructions/${name}.md`);
}

export async function assemblePromptShell(): Promise<string[]> {
  const parts: string[] = [];
  const now = new Date();

  const soul = await readContextFile("soul.md");
  parts.push(soul ?? "You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");

  parts.push(`## Current Mood\n${moodForTimeOfDay(timeOfDayFor(now))}`);

  parts.push(DATETIME_CONTEXT(now));

  const toolBehavior = await readInstruction("tool-behavior");
  if (toolBehavior) parts.push(toolBehavior);

  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    const maid = await readInstruction("maid-service");
    if (maid) parts.push(maid);
  }

  if (config.BRAVE_SEARCH_API_KEY) {
    const webSearch = await readInstruction("web-search");
    if (webSearch) parts.push(webSearch);
  }

  if (config.BROWSER_ENABLED) {
    const browser = await readInstruction("browser");
    if (browser) parts.push(browser);
  }

  const routines = await readInstruction("routines");
  if (routines) parts.push(routines);

  return parts;
}

async function assembleRoutineContext(chatId: string): Promise<string | null> {
  try {
    const routines = await listRoutinesForChat(chatId);
    const enabled = routines.filter((s) => s.enabled);
    if (enabled.length === 0) return null;

    const names = enabled.map((s) => s.name).join(", ");
    return `## Available Routines\n${names}\nUse searchRoutines to look up details or discover routines by keyword.`;
  } catch (error) {
    logger.warn({ err: error }, "Failed to load routine context");
    return null;
  }
}

async function assemblePendingConfirmationsContext(chatId: string): Promise<string | null> {
  try {
    const pending = await listPendingConfirmations(chatId);
    if (pending.length === 0) return null;

    const lines = pending.map((row) => {
      const ageMs = Date.now() - row.createdAt.getTime();
      const ago = formatDistanceToNow(row.createdAt, { addSuffix: false });
      const stale = ageMs > 60 * 60_000 ? " (stale — consider cancelling if no longer wanted)" : "";
      return `- ${ago} ago — ${row.summary} (id: ${String(row._id)})${stale}`;
    });
    return (
      "## Pending Approvals\n" +
      lines.join("\n") +
      "\nThese are tap-to-approve requests already sent to Goshujin-sama. Don't re-prompt for the same action; wait for him, or call cancelConfirmation with the id if he wants to abort."
    );
  } catch (error) {
    logger.warn({ err: error }, "Failed to load pending confirmations for context");
    return null;
  }
}

async function assembleLocationContext(chatId: string): Promise<string | null> {
  if (!config.LOCATION_ENABLED) return null;

  try {
    const latest = await getLatestLocation(chatId);
    if (!latest) return null;

    const ageMs = Date.now() - latest.timestamp.getTime();
    const maxAgeMs = config.LOCATION_CONTEXT_MAX_AGE_H * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) return null;

    const ago = formatDistanceToNow(latest.timestamp, { addSuffix: true });
    const name =
      latest.placeName ?? `${latest.latitude.toFixed(4)}, ${latest.longitude.toFixed(4)}`;
    const category = latest.placeCategory ? ` (${latest.placeCategory})` : "";
    const live = latest.isLive ? "\n(live location sharing is active)" : "";

    return `## Location\nLast known: ${name}${category}, ${ago}${live}`;
  } catch (error) {
    logger.warn({ err: error }, "Failed to load location context");
    return null;
  }
}

export async function assembleSystemPrompt(chatId: string): Promise<string> {
  const parts = await assemblePromptShell();

  const routineContext = await assembleRoutineContext(chatId);
  if (routineContext) parts.push(routineContext);

  const pendingContext = await assemblePendingConfirmationsContext(chatId);
  if (pendingContext) parts.push(pendingContext);

  const locationContext = await assembleLocationContext(chatId);
  if (locationContext) parts.push(locationContext);

  const responseFormat = await readInstruction("response-format");
  if (responseFormat) parts.push(responseFormat);

  return parts.join("\n\n---\n\n");
}

async function assembleReminderContext(chatId: string): Promise<string | null> {
  try {
    const [pending, fired] = await Promise.all([
      listRemindersForChat(chatId),
      getRecentlyFiredReminders(chatId),
    ]);

    if (pending.length === 0 && fired.length === 0) return null;

    const lines: string[] = [];

    for (const r of pending) {
      const time = format(r.fireAt, "MMM d, h:mm a");
      lines.push(`- "${r.message}" → fires at ${time}`);
    }

    for (const r of fired) {
      const time = format(r.fireAt, "MMM d, h:mm a");
      lines.push(`- "${r.message}" → fired at ${time} (done)`);
    }

    return "## Active Reminders\n" + lines.join("\n");
  } catch (error) {
    logger.warn({ err: error }, "Failed to load reminder context");
    return null;
  }
}

export async function assembleProactiveSystemPrompt(chatId: string): Promise<string> {
  const parts = await assemblePromptShell();

  const reminderContext = await assembleReminderContext(chatId);
  if (reminderContext) {
    parts.push(reminderContext);
  }

  const pendingContext = await assemblePendingConfirmationsContext(chatId);
  if (pendingContext) parts.push(pendingContext);

  const locationContext = await assembleLocationContext(chatId);
  if (locationContext) parts.push(locationContext);

  const proactive = await readInstruction("proactive-message");
  if (proactive) parts.push(proactive);

  return parts.join("\n\n---\n\n");
}

const TOOL_RESULT_KEEP_LAST = 10;

export async function assembleMessages(chatId: string): Promise<ModelMessage[]> {
  const history = await getRecentMessages(chatId, 40);

  logger.debug(
    {
      historyCount: history.length,
      roles: history.map((m) => m.role),
    },
    "Message history loaded",
  );

  const messages: ModelMessage[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const isRecent = i >= history.length - TOOL_RESULT_KEEP_LAST;

    if (msg.role === "user") {
      let content: UserContent = msg.content;
      if (msg.imageRef) {
        const img = await readImage(msg.imageRef);
        if (img) {
          content = [
            { type: "image", image: img.data.toString("base64"), mediaType: img.mimeType },
            { type: "text", text: msg.content },
          ];
        }
      }
      messages.push({ role: "user", content });
    } else {
      if (msg.toolCalls?.length && isRecent) {
        const callIdBase = `tc_${messages.length}`;
        messages.push({
          role: "assistant",
          content: msg.toolCalls.map((tc, i) => ({
            type: "tool-call" as const,
            toolCallId: `${callIdBase}_${i}`,
            toolName: tc.toolName,
            input: tc.args ?? {},
          })),
        });
        messages.push({
          role: "tool",
          content: msg.toolCalls.map((tc, i) => {
            let parsed: unknown = "done";
            if (tc.result) {
              try {
                parsed = JSON.parse(tc.result);
              } catch {
                parsed = tc.result;
              }
            }
            return {
              type: "tool-result" as const,
              toolCallId: `${callIdBase}_${i}`,
              toolName: tc.toolName,
              output:
                typeof parsed === "string"
                  ? { type: "text" as const, value: parsed }
                  : { type: "json" as const, value: parsed },
            };
          }) as ToolContent,
        });
      }
      if (msg.content) {
        messages.push({ role: "assistant", content: msg.content });
      }
    }
  }

  return messages;
}
