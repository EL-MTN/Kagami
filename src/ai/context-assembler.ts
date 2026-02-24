import { format } from "date-fns";
import { readVaultFile } from "../memory/vault.js";
import { getRecentMessages } from "../db/models/conversation.js";
import * as engine from "../memory/engine.js";
import {
  TOOL_USAGE_INSTRUCTIONS,
  DATETIME_CONTEXT,
  RESPONSE_FORMAT_INSTRUCTIONS,
  PROACTIVE_MESSAGE_INSTRUCTIONS,
} from "./prompts.js";
import { logger } from "../utils/logger.js";
import type { CoreMessage, UserContent } from "ai";

async function assembleMemoryContext(): Promise<string[]> {
  const parts: string[] = [];

  // Recent episode context (last 2-3 conversation summaries)
  try {
    const recentEpisodes = await engine.getRecentEpisodes(3);
    if (recentEpisodes.length > 0) {
      const episodeText = recentEpisodes
        .map((e) => `[${format(e.metadata.createdAt, "MMM d")}] ${e.content}`)
        .join("\n\n");
      parts.push("## Recent Memories\n" + episodeText);
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load recent episodes for context");
  }

  // Active follow-ups
  try {
    const followUps = await engine.getActiveFollowUps();
    if (followUps.length > 0) {
      parts.push("## Things to Follow Up On\n" + followUps.map((f) => `- ${f}`).join("\n"));
    }
  } catch (error) {
    logger.warn({ error }, "Failed to load follow-ups for context");
  }

  return parts;
}

export async function assembleSystemPrompt(): Promise<string> {
  const parts: string[] = [];

  // 1. Personality card
  const personality = await readVaultFile("personality/card.md");
  if (personality) {
    parts.push(personality.content);
  } else {
    logger.warn("Personality card not found at vault/personality/card.md");
    parts.push("You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");
  }

  // 2. User knowledge
  const aboutYou = await readVaultFile("memories/about-you.md");
  if (aboutYou) {
    parts.push("## What You Know About Him\n" + aboutYou.content);
  }

  // 3. Milestones
  const milestones = await readVaultFile("memories/milestones.md");
  if (milestones) {
    parts.push("## Relationship History\n" + milestones.content);
  }

  // 3.5. Recent episode context + follow-ups
  const memoryContext = await assembleMemoryContext();
  parts.push(...memoryContext);

  // 4. Date/time
  parts.push(DATETIME_CONTEXT(new Date()));

  // 5. Tool instructions
  parts.push(TOOL_USAGE_INSTRUCTIONS);

  // 6. Response format
  parts.push(RESPONSE_FORMAT_INSTRUCTIONS);

  return parts.join("\n\n---\n\n");
}

export async function assembleProactiveSystemPrompt(): Promise<string> {
  const parts: string[] = [];

  const personality = await readVaultFile("personality/card.md");
  if (personality) {
    parts.push(personality.content);
  } else {
    logger.warn("Personality card not found at vault/personality/card.md");
    parts.push("You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");
  }

  const aboutYou = await readVaultFile("memories/about-you.md");
  if (aboutYou) {
    parts.push("## What You Know About Him\n" + aboutYou.content);
  }

  const milestones = await readVaultFile("memories/milestones.md");
  if (milestones) {
    parts.push("## Relationship History\n" + milestones.content);
  }

  // Recent episode context + follow-ups
  const memoryContext = await assembleMemoryContext();
  parts.push(...memoryContext);

  parts.push(DATETIME_CONTEXT(new Date()));
  parts.push(TOOL_USAGE_INSTRUCTIONS);
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
      if (msg.imageBase64) {
        content = [
          { type: "image", image: msg.imageBase64, mimeType: msg.imageMimeType },
          { type: "text", text: msg.content },
        ];
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
