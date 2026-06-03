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
  getRoutineHealth,
  listPendingConfirmations,
  type RoutineHealth,
} from "@kokoro/db";
import { DATETIME_CONTEXT, moodForTimeOfDay, timeOfDayFor } from "./prompts";
import { getMcpSummary } from "../services/mcp";
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

async function assemblePromptShell(
  includeMcpHint: boolean,
  includeProposalRule: boolean = includeMcpHint,
): Promise<string[]> {
  const parts: string[] = [];
  const now = new Date();

  const soul = await readContextFile("soul.md");
  parts.push(soul ?? "You are Shiina Mashiro, a quiet and eccentric artist girlfriend.");

  parts.push(`## Current Mood\n${moodForTimeOfDay(timeOfDayFor(now))}`);

  parts.push(DATETIME_CONTEXT(now));

  const toolBehavior = await readInstruction("tool-behavior");
  if (toolBehavior) parts.push(toolBehavior);

  if (config.KAO_URL) {
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

  // Load the proposeRoutine / proposeRoutineRefinement rules only where the
  // tools are actually offered — live conversational turns. Excluded from the
  // no-tools acknowledgment turn (includeProposalRule defaults to
  // includeMcpHint = false there) and from proactive outreach (passes
  // includeProposalRule: false explicitly), keeping the rules and the tools'
  // `conversational` gate in lockstep.
  if (includeProposalRule) {
    const routineProposals = await readInstruction("routine-proposals");
    if (routineProposals) parts.push(routineProposals);
    const routineRefinement = await readInstruction("routine-refinement");
    if (routineRefinement) parts.push(routineRefinement);
  }

  // Only advertise MCP tools on turns that actually expose them. The
  // acknowledgment turn (acknowledge.ts) passes no tools, so it opts out.
  if (includeMcpHint) {
    const mcp = assembleMcpContext();
    if (mcp) parts.push(mcp);
  }

  return parts;
}

/**
 * Lists tools mounted from connected MCP servers so the model knows they're
 * available (and what each server is for). Reads cached runtime state from the
 * MCP manager; null when no servers are connected. Tool-level semantics travel
 * on each tool's own description — this is just the discovery hint, mirroring
 * how `assembleRoutineContext` surfaces available routine names.
 */
function assembleMcpContext(): string | null {
  const servers = getMcpSummary();
  if (servers.length === 0) return null;

  const lines = servers.map((s) => {
    const tools = s.toolNames.length > 0 ? s.toolNames.join(", ") : "(no tools)";
    const hint = s.instructions
      ? ` — ${s.instructions.replace(/\s+/g, " ").trim().slice(0, 300)}`
      : "";
    return `- **${s.name}** (${s.transport})${hint}\n  tools: ${tools}`;
  });

  return (
    "## External Tools (MCP)\n" +
    "These tools come from connected MCP servers. Use them like any built-in tool when relevant.\n" +
    lines.join("\n")
  );
}

/**
 * Display threshold for flagging a routine as underperforming in the prompt.
 * This decides only whether to *show* the ⚠ marker (so a single flaky run
 * doesn't nag the model into offering a fix); the decision to actually refine
 * stays entirely with the LLM. `[no report]` runs are healthy and never count.
 */
function routineHealthNote(h: RoutineHealth): string | null {
  if (h.totalRuns === 0) return null;
  const bad = h.failedRuns + h.emptyRuns;
  if (bad < 2 && h.lastStatus !== "failed") return null;
  const kind = h.failedRuns >= h.emptyRuns ? "failing" : "returning empty";
  const detail = h.lastError ? ` (last error: "${h.lastError.slice(0, 80)}")` : "";
  return `⚠ ${kind} — ${bad} of last ${h.totalRuns} runs${detail}`;
}

/**
 * Lists the chat's enabled routines for the prompt. On conversational turns
 * (`withHealth`), routines with a poor recent track record are annotated so the
 * model can notice and offer a `proposeRoutineRefinement`. Health is an
 * enhancement, never a requirement — any failure falls back to plain names.
 */
async function assembleRoutineContext(chatId: string, withHealth: boolean): Promise<string | null> {
  try {
    const routines = await listRoutinesForChat(chatId);
    const enabled = routines.filter((s) => s.enabled);
    if (enabled.length === 0) return null;

    let health: Map<string, RoutineHealth> | null = null;
    if (withHealth) {
      try {
        const rows = await getRoutineHealth(chatId);
        health = new Map(rows.map((h) => [h.name, h]));
      } catch (error) {
        logger.warn({ error }, "Failed to load routine health — listing names only");
      }
    }

    const flagged = health !== null;
    const lines = enabled.map((s) => {
      const note = health?.get(s.name);
      const annotation = note ? routineHealthNote(note) : null;
      return annotation ? `${s.name} ${annotation}` : s.name;
    });

    const offerHint = flagged
      ? "\nIf a routine is flagged ⚠ above, you may offer to fix its prompt with proposeRoutineRefinement — on a natural turn, one at a time."
      : "";
    return `## Available Routines\n${lines.join("\n")}\nUse searchRoutines to look up details or discover routines by keyword.${offerHint}`;
  } catch (error) {
    logger.warn({ error: error }, "Failed to load routine context");
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
      // Skip the stale-cancel nudge for routine proposals: an ignored "want me
      // to save this?" offer should just TTL out (it's short-lived), not nag
      // the model to cancel it. They're still listed so the model knows one is
      // pending and won't re-propose.
      const isProposal = row.action.tool === "createRoutine";
      const stale =
        !isProposal && ageMs > 60 * 60_000
          ? " (stale — consider cancelling if no longer wanted)"
          : "";
      return `- ${ago} ago — ${row.summary} (id: ${String(row._id)})${stale}`;
    });
    return (
      "## Pending Approvals\n" +
      lines.join("\n") +
      "\nThese are tap-to-approve requests already sent to Goshujin-sama. Don't re-prompt for the same action; wait for him, or call cancelConfirmation with the id if he wants to abort."
    );
  } catch (error) {
    logger.warn({ error: error }, "Failed to load pending confirmations for context");
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
    logger.warn({ error: error }, "Failed to load location context");
    return null;
  }
}

export async function assembleSystemPrompt(
  chatId: string,
  opts: { includeMcpHint?: boolean } = {},
): Promise<string> {
  const { includeMcpHint = true } = opts;
  const parts = await assemblePromptShell(includeMcpHint);

  // `includeMcpHint` is the conversational-turn signal (generate.ts uses the
  // default true; the no-tools acknowledgment turn passes false) — the same
  // gate `assemblePromptShell` uses for the proposal/refinement rule. Only
  // conversational turns expose proposeRoutineRefinement, so only they pay the
  // health lookup and show the ⚠ annotations.
  const routineContext = await assembleRoutineContext(chatId, includeMcpHint);
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
    logger.warn({ error: error }, "Failed to load reminder context");
    return null;
  }
}

export async function assembleProactiveSystemPrompt(chatId: string): Promise<string> {
  // Proactive turns use allTools (MCP included), so advertise the MCP hint —
  // but NOT the proposeRoutine rule: proactive outreach isn't a user-initiated
  // task-completion turn, and `allTools` withholds proposeRoutine there
  // (conversational is false), so advertising it would dangle a missing tool.
  const parts = await assemblePromptShell(true, false);

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
