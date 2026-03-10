import { format } from "date-fns";
import { readVaultFile } from "@mashiro/memory";
import {
  getRecentMessages,
  readImage,
  listRemindersForChat,
  getRecentlyFiredReminders,
} from "@mashiro/db";
import * as engine from "@mashiro/memory";
import {
  TOOL_BEHAVIOR_GUIDELINES,
  MAID_SERVICE_INSTRUCTIONS,
  BROWSER_INSTRUCTIONS,
  DATETIME_CONTEXT,
  RESPONSE_FORMAT_INSTRUCTIONS,
  PROACTIVE_MESSAGE_INSTRUCTIONS,
} from "./prompts";
import { config, logger } from "@mashiro/shared";
import type { ModelMessage, UserContent, ToolContent } from "ai";

async function assembleMemoryContext(sessionId?: string): Promise<string[]> {
  const parts: string[] = [];

  // Separated episode types (fixes conflation bug)
  try {
    const dailyEpisodes = await engine.getRecentDailyEpisodes(3);
    if (dailyEpisodes.length > 0) {
      const episodeText = dailyEpisodes
        .map((e) => `[${format(e.metadata.createdAt, "MMM d")}] ${e.content}`)
        .join("\n\n");
      parts.push("## Recent Conversations\n" + episodeText);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load recent daily episodes for context");
  }

  try {
    const weeklyEpisodes = await engine.getRecentWeeklyEpisodes(2);
    if (weeklyEpisodes.length > 0) {
      const weeklyText = weeklyEpisodes
        .map((e) => `[${format(e.metadata.createdAt, "MMM d")}] ${e.content}`)
        .join("\n\n");
      parts.push("## Recent Weeks\n" + weeklyText);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load weekly episodes for context");
  }

  // Working memory (session-scoped)
  if (sessionId) {
    try {
      const workingMems = await engine.getWorkingMemories(sessionId);
      if (workingMems.length > 0) {
        const notes = workingMems.map((m) => `- ${m.content}`).join("\n");
        parts.push("## Currently Tracking\n" + notes);
      }
    } catch (error) {
      logger.warn({ error }, "Failed to load working memories for context");
    }
  }

  // Active follow-ups (with age filter + dedup)
  try {
    const followUps = await engine.getActiveFollowUps();
    if (followUps.length > 0) {
      parts.push("## Things to Follow Up On\n" + followUps.map((f) => `- ${f}`).join("\n"));
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load follow-ups for context");
  }

  // Emotional trajectory — only inject when trend is notable
  try {
    const baseline = await engine.getEmotionalBaseline();
    if (baseline && baseline.trend !== "stable") {
      const avg = baseline.average.toFixed(1);
      const note =
        baseline.trend === "rising"
          ? `Things have been feeling better lately (mood trending up, avg ${avg}/10)`
          : `He seems to have been down recently (mood trending lower, avg ${avg}/10)`;
      parts.push("## Emotional Note\n" + note);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load emotional baseline for context");
  }

  return parts;
}

/**
 * Shared prompt shell: personality card + datetime + tool/service instructions.
 * Used by both conversation prompts and workflow prompts.
 */
export async function assemblePromptShell(): Promise<string[]> {
  const parts: string[] = [];

  // Personality card (from vault — hand-edited)
  const personality = await readVaultFile("personality/card.md");
  if (personality) {
    parts.push(personality.content);
  } else {
    logger.warn("Personality card not found at vault/personality/card.md");
    parts.push("You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");
  }

  // Date/time
  parts.push(DATETIME_CONTEXT(new Date()));

  // Tool behavioral guidelines (tool schemas are self-describing)
  parts.push(TOOL_BEHAVIOR_GUIDELINES);

  // Maid service instructions (only when Google credentials are configured)
  if (config.GOOGLE_OAUTH_CLIENT_ID) {
    parts.push(MAID_SERVICE_INSTRUCTIONS);
  }

  // Browser instructions (only when browser is enabled)
  if (config.BROWSER_ENABLED) {
    parts.push(BROWSER_INSTRUCTIONS);
  }

  return parts;
}

async function assembleBasePrompt(sessionId?: string): Promise<string[]> {
  const parts = await assemblePromptShell();

  // User knowledge (from MongoDB, not vault)
  try {
    const facts = await engine.getTopFacts(30);
    if (facts.length > 0) {
      const factList = facts.map((f) => `- ${f.content}`).join("\n");
      parts.push("## What You Know About Him\n" + factList);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load facts for context");
  }

  // Milestones (from MongoDB, not vault)
  try {
    const milestones = await engine.getRecentMilestones(5);
    if (milestones.length > 0) {
      const milestoneList = milestones
        .map((m) => `[${format(m.metadata.createdAt, "MMM yyyy")}] ${m.content}`)
        .join("\n\n");
      parts.push("## Relationship History\n" + milestoneList);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load milestones for context");
  }

  // Recent episode context + follow-ups + working memory
  const memoryContext = await assembleMemoryContext(sessionId);
  parts.push(...memoryContext);

  return parts;
}

export async function assembleSystemPrompt(sessionId?: string): Promise<string> {
  const parts = await assembleBasePrompt(sessionId);
  parts.push(RESPONSE_FORMAT_INSTRUCTIONS);
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
    logger.warn({ error }, "Failed to load reminder context");
    return null;
  }
}

export async function assembleProactiveSystemPrompt(
  chatId: string,
  sessionId?: string,
): Promise<string> {
  const parts = await assembleBasePrompt(sessionId);

  const reminderContext = await assembleReminderContext(chatId);
  if (reminderContext) {
    parts.push(reminderContext);
  }

  parts.push(PROACTIVE_MESSAGE_INSTRUCTIONS);
  return parts.join("\n\n---\n\n");
}

// Only reconstruct full tool-call/tool-result pairs for the last N raw messages.
// Older tool results are dropped — the assistant's text response already contains
// the synthesized answer, so replaying raw JSON from many turns ago adds no value.
const TOOL_RESULT_KEEP_LAST = 10;

export async function assembleMessages(chatId: string): Promise<ModelMessage[]> {
  // History already includes the current message (saved before this call)
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
      // Only reconstruct tool-call / tool-result pairs for recent messages.
      // Older tool results are dropped to save context window space.
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
