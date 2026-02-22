import { generateText } from "ai";
import { format, subDays } from "date-fns";
import { getModel } from "../ai/provider.js";
import { Conversation } from "../db/models/conversation.js";
import { readVaultFile, writeVaultFile, listVaultFiles } from "./vault.js";
import { logger } from "../utils/logger.js";

export async function curateMemories(
  scope: "daily" | "weekly",
): Promise<void> {
  if (scope === "daily") {
    await generateDailySummary();
  } else {
    await weeklyDeepCuration();
  }
}

async function generateDailySummary(): Promise<void> {
  const yesterday = subDays(new Date(), 1);
  const dateStr = format(yesterday, "yyyy-MM-dd");
  const summaryPath = `memories/conversations/${dateStr}.md`;

  // Skip if already exists
  const existing = await readVaultFile(summaryPath);
  if (existing) {
    logger.debug({ dateStr }, "Daily summary already exists");
    return;
  }

  // Get yesterday's conversations
  const startOfDay = new Date(yesterday);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(yesterday);
  endOfDay.setHours(23, 59, 59, 999);

  const convos = await Conversation.find({
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  if (convos.length === 0) {
    logger.debug({ dateStr }, "No conversations to summarize");
    return;
  }

  const allMessages = convos.flatMap((c) => c.messages);
  if (allMessages.length < 3) return;

  const transcript = allMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Summarize conversations into key points. Extract:
1. Important facts learned about the user
2. Emotional highlights (good moments, concerns)
3. Topics discussed
4. Any promises, plans, or follow-ups mentioned

Be concise. Use bullet points. Write from the perspective of Luna (the girlfriend AI) remembering the day.`,
    messages: [
      {
        role: "user",
        content: `Summarize this day's conversation:\n\n${transcript}`,
      },
    ],
  });

  await writeVaultFile(
    summaryPath,
    result.text,
    { type: "daily-summary", date: dateStr },
  );

  // Also update about-you.md with any new facts
  await updateUserFacts(result.text);

  logger.info({ dateStr }, "Daily summary generated");
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
        content: `Existing file:\n${aboutYou.content}\n\nToday's summary:\n${summary}`,
      },
    ],
  });

  if (result.text.trim() !== "NONE" && result.text.trim().length > 5) {
    const updated = aboutYou.content + "\n\n## Updated " + format(new Date(), "yyyy-MM-dd") + "\n" + result.text;
    await writeVaultFile("memories/about-you.md", updated, aboutYou.frontmatter);
    logger.info("Updated about-you.md with new facts");
  }
}

async function weeklyDeepCuration(): Promise<void> {
  // Merge old daily summaries into a single week summary
  const files = await listVaultFiles("memories/conversations");
  const oneWeekAgo = format(subDays(new Date(), 7), "yyyy-MM-dd");

  const oldFiles = files.filter((f) => {
    const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
    return dateMatch && dateMatch[1] < oneWeekAgo;
  });

  if (oldFiles.length < 3) {
    logger.debug("Not enough old files for weekly curation");
    return;
  }

  const contents: string[] = [];
  for (const file of oldFiles) {
    const data = await readVaultFile(file);
    if (data) contents.push(`## ${file}\n${data.content}`);
  }

  const result = await generateText({
    model: getModel(),
    system: `You are a memory curator. Compress multiple daily summaries into a single weekly summary. Keep the most important facts, memorable moments, and evolving patterns. Remove redundancy. Write from Luna's perspective.`,
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

export function startCurationSchedule(): NodeJS.Timeout {
  // Run daily curation at 4am
  const FOUR_HOURS = 4 * 60 * 60 * 1000;

  const interval = setInterval(async () => {
    const hour = new Date().getHours();
    if (hour === 4) {
      try {
        await curateMemories("daily");
      } catch (error) {
        logger.error({ error }, "Daily curation failed");
      }
    }
    // Weekly on Mondays at 4am
    if (hour === 4 && new Date().getDay() === 1) {
      try {
        await curateMemories("weekly");
      } catch (error) {
        logger.error({ error }, "Weekly curation failed");
      }
    }
  }, FOUR_HOURS);

  logger.info("Memory curation schedule started");
  return interval;
}
