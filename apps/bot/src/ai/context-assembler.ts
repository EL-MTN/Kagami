import { format } from "date-fns";
import { readVaultFile } from "@mashiro/memory";
import { getRecentMessages, readImage } from "@mashiro/db";
import * as engine from "@mashiro/memory";
import {
  TOOL_USAGE_INSTRUCTIONS,
  MAID_SERVICE_INSTRUCTIONS,
  BROWSER_INSTRUCTIONS,
  DATETIME_CONTEXT,
  RESPONSE_FORMAT_INSTRUCTIONS,
  PROACTIVE_MESSAGE_INSTRUCTIONS,
} from "./prompts";
import { config, logger } from "@mashiro/shared";
import type { CoreMessage, UserContent } from "ai";

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

  // Tool instructions
  parts.push(TOOL_USAGE_INSTRUCTIONS);

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

export async function assembleProactiveSystemPrompt(sessionId?: string): Promise<string> {
  const parts = await assembleBasePrompt(sessionId);
  parts.push(PROACTIVE_MESSAGE_INSTRUCTIONS);
  return parts.join("\n\n---\n\n");
}

export async function assembleMessages(chatId: string): Promise<CoreMessage[]> {
  // History already includes the current message (saved before this call)
  const history = await getRecentMessages(chatId, 40);

  logger.debug(
    {
      historyCount: history.length,
      roles: history.map((m) => m.role),
    },
    "Message history loaded",
  );

  const messages: CoreMessage[] = [];

  for (const msg of history) {
    if (msg.role === "user") {
      let content: UserContent = msg.content;
      if (msg.imageRef) {
        const img = await readImage(msg.imageRef);
        if (img) {
          content = [
            { type: "image", image: img.data.toString("base64"), mimeType: img.mimeType },
            { type: "text", text: msg.content },
          ];
        }
      }
      messages.push({ role: "user", content });
    } else {
      // Reconstruct tool-call / tool-result pairs so the model
      // can see what tools it used in previous turns
      if (msg.toolCalls?.length) {
        const callIdBase = `tc_${messages.length}`;
        messages.push({
          role: "assistant",
          content: msg.toolCalls.map((tc, i) => ({
            type: "tool-call" as const,
            toolCallId: `${callIdBase}_${i}`,
            toolName: tc.toolName,
            args: tc.args,
          })),
        });
        messages.push({
          role: "tool",
          content: msg.toolCalls.map((tc, i) => {
            let result: unknown = "done";
            if (tc.result) {
              try {
                result = JSON.parse(tc.result);
              } catch {
                result = tc.result;
              }
            }
            return {
              type: "tool-result" as const,
              toolCallId: `${callIdBase}_${i}`,
              toolName: tc.toolName,
              result,
            };
          }),
        });
      }
      if (msg.content) {
        messages.push({ role: "assistant", content: msg.content });
      }
    }
  }

  return messages;
}
