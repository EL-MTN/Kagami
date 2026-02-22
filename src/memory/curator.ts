import { generateText } from "ai";
import { format, subDays } from "date-fns";
import { getModel } from "../ai/provider.js";
import { getOverflowMessages, trimConversation } from "../db/models/conversation.js";
import { readVaultFile, writeVaultFile, listVaultFiles } from "./vault.js";
import { logger } from "../utils/logger.js";

const CONTEXT_LIMIT = 40;

export async function curateIfNeeded(chatId: string): Promise<void> {
  const overflow = await getOverflowMessages(chatId, CONTEXT_LIMIT);
  if (!overflow) return;

  logger.info(
    { chatId, overflowCount: overflow.overflow.length, total: overflow.total },
    "Context overflow detected, curating messages",
  );

  // Format overflow as transcript
  const transcript = overflow.overflow
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  // Summarize overflow
  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Summarize conversations into key points. Extract:
1. Important facts learned about the user
2. Emotional highlights (good moments, concerns)
3. Topics discussed
4. Any promises, plans, or follow-ups mentioned

Be concise. Use bullet points. Write from the perspective of Mashiro (the girlfriend AI) remembering the conversation.`,
    messages: [
      {
        role: "user",
        content: `Summarize this conversation segment:\n\n${transcript}`,
      },
    ],
  });

  // Write summary to vault
  const timestamp = format(new Date(), "yyyy-MM-dd'T'HH-mm-ss");
  const summaryPath = `memories/conversations/${timestamp}.md`;
  await writeVaultFile(summaryPath, result.text, {
    type: "conversation-summary",
    chatId,
    messageCount: overflow.overflow.length,
    timestamp: new Date().toISOString(),
  });

  // Update about-you.md with new facts
  await updateUserFacts(result.text);

  // Trim conversation to keep only recent messages
  await trimConversation(overflow.conversationId, CONTEXT_LIMIT);

  logger.info(
    { summaryPath, trimmedTo: CONTEXT_LIMIT },
    "Curation complete: summarized overflow and trimmed conversation",
  );

  // Check if weekly merge is due
  await checkWeeklyMerge();
}

async function updateUserFacts(summary: string): Promise<void> {
  const aboutYou = await readVaultFile("memories/about-you.md");
  if (!aboutYou) return;

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Given a conversation summary and an existing "About You" file, extract any NEW facts about the user that aren't already in the file. Output only the new bullet points to append, or "NONE" if there's nothing new. Be concise.`,
    messages: [
      {
        role: "user",
        content: `Existing file:\n${aboutYou.content}\n\nConversation summary:\n${summary}`,
      },
    ],
  });

  if (result.text.trim() !== "NONE" && result.text.trim().length > 5) {
    const updated = aboutYou.content + "\n\n## Updated " + format(new Date(), "yyyy-MM-dd") + "\n" + result.text;
    await writeVaultFile("memories/about-you.md", updated, aboutYou.frontmatter);
    logger.info("Updated about-you.md with new facts");
  }
}

async function checkWeeklyMerge(): Promise<void> {
  const files = await listVaultFiles("memories/conversations");
  const oneWeekAgo = format(subDays(new Date(), 7), "yyyy-MM-dd");

  // Find daily summary files (not weekly rollups) older than 7 days
  const oldDailyFiles = files.filter((f) => {
    if (f.includes("week-of-")) return false;
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch && dateMatch[1] < oneWeekAgo;
  });

  if (oldDailyFiles.length >= 7) {
    logger.info({ fileCount: oldDailyFiles.length }, "Triggering weekly merge");
    await weeklyDeepCuration(oldDailyFiles);
  }
}

async function weeklyDeepCuration(oldFiles: string[]): Promise<void> {
  const contents: string[] = [];
  for (const file of oldFiles) {
    const data = await readVaultFile(file);
    if (data) contents.push(`## ${file}\n${data.content}`);
  }

  if (contents.length === 0) return;

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Compress multiple daily summaries into a single weekly summary. Keep the most important facts, memorable moments, and evolving patterns. Remove redundancy. Write from Mashiro's perspective.`,
    messages: [
      {
        role: "user",
        content: `Compress these daily summaries:\n\n${contents.join("\n\n")}`,
      },
    ],
  });

  const weekOf = format(subDays(new Date(), 7), "yyyy-MM-dd");
  await writeVaultFile(
    `memories/conversations/week-of-${weekOf}.md`,
    result.text,
    { type: "weekly-summary", weekOf },
  );

  logger.info({ weekOf, mergedFiles: oldFiles.length }, "Weekly curation complete");
}
