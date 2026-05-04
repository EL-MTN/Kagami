import { tool } from "ai";
import { z } from "zod";
import {
  acquireBrowser,
  releaseBrowser,
  resetBrowser,
  withBrowserLock,
} from "../../services/browser";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";

const SearchResultSchema = z.array(
  z.object({
    title: z.string().describe("The title of the search result"),
    url: z.string().describe("The full URL of the search result including https://"),
    snippet: z.string().describe("The snippet/description of the search result"),
  }),
);

function normalizeUrl(raw: string): string {
  if (!/^https?:\/\//i.test(raw)) return `https://${raw}`;
  return raw;
}

const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — autonomous 25-step runs can be slow

function isFatalBrowserError(message: string): boolean {
  return (
    message.includes("Target closed") ||
    message.includes("Browser closed") ||
    message.includes("timed out")
  );
}

const ALL_BROWSE_ACTIONS = [
  "search",
  "visit",
  "extract",
  "act",
  "screenshot",
  "agent",
  "login",
] as const;
type BrowseAction = (typeof ALL_BROWSE_ACTIONS)[number];

const READ_ONLY_ACTIONS = ["search", "visit", "extract"] as const satisfies readonly BrowseAction[];

interface BrowseFactoryOptions {
  /** Subset of actions to expose. The schema enum gates the rest before execute runs. */
  allowedActions: readonly BrowseAction[];
  description: string;
  /** Prefix for log lines and lock labels — e.g. "browse" or "browse-readonly". */
  logPrefix: string;
  /** Required when "screenshot" is allowed — used to deliver the captured image. */
  chatId?: string;
  adapter?: PlatformAdapter;
}

function createBrowseToolImpl(options: BrowseFactoryOptions) {
  const { allowedActions, description, logPrefix, chatId, adapter } = options;
  const actionEnum = z.enum(allowedActions as [BrowseAction, ...BrowseAction[]]);

  return tool({
    description,
    inputSchema: z.object({
      action: actionEnum,
      query: z.string().optional().describe("Search query (for search action)"),
      url: z.string().optional().describe("URL to visit (for visit action)"),
      instruction: z
        .string()
        .optional()
        .describe("Natural language instruction (for extract/act actions)"),
      goal: z
        .string()
        .optional()
        .describe("High-level goal for autonomous multi-step browsing (for agent action)"),
    }),
    execute: async ({ action, query, url, instruction, goal }) => {
      // Serialize browser access — parallel tool calls share one page.
      // Agent runs are budgeted longer than the default circuit-breaker.
      const timeoutMs = action === "agent" ? AGENT_TIMEOUT_MS : undefined;
      return withBrowserLock(
        async () => {
          let acquired = false;
          let keepAlive = false;
          let resetDone = false;
          try {
            const stagehand = await acquireBrowser();
            acquired = true;
            const page = stagehand.context.pages()[0];

            switch (action) {
              case "search": {
                if (!query) return { success: false, reason: "query is required for search" };
                logger.info({ query }, `Tool: ${logPrefix} (search)`);
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                await page.goto(searchUrl);
                const results = await stagehand.extract(
                  "Extract all search results with their title, URL, and snippet/description text",
                  SearchResultSchema,
                );
                return { success: true, query, results: results.slice(0, 10) };
              }

              case "visit": {
                if (!url) return { success: false, reason: "url is required for visit" };
                const visitUrl = normalizeUrl(url);
                logger.info({ url: visitUrl }, `Tool: ${logPrefix} (visit)`);
                await page.goto(visitUrl, { waitUntil: "domcontentloaded" });
                const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
                const truncated = pageText.slice(0, 4000);
                return {
                  success: true,
                  url: visitUrl,
                  text: truncated,
                  truncated: pageText.length > 4000,
                };
              }

              case "extract": {
                if (!instruction)
                  return { success: false, reason: "instruction is required for extract" };
                logger.info({ instruction }, `Tool: ${logPrefix} (extract)`);
                const result = (await stagehand.extract(instruction)) as { extraction?: string };
                return { success: true, extraction: result.extraction ?? "" };
              }

              case "act": {
                if (!instruction)
                  return { success: false, reason: "instruction is required for act" };
                logger.info({ instruction }, `Tool: ${logPrefix} (act)`);
                await stagehand.act(instruction);
                return { success: true, performed: instruction };
              }

              case "screenshot": {
                // The public createBrowseTool wrapper is the only caller that
                // includes "screenshot" in allowedActions today, and it
                // requires chatId/adapter as positional args. There's no
                // type-level link between the action set and these fields,
                // so this runtime check catches any future caller that
                // builds allowedActions directly without supplying them.
                if (!chatId || !adapter) {
                  return { success: false, reason: "screenshot is not available in this context" };
                }
                logger.info(`Tool: ${logPrefix} (screenshot)`);
                const buffer = await page.screenshot();
                await adapter.sendPhotoBuffer(chatId, Buffer.from(buffer));
                return { success: true, sent: true };
              }

              case "agent": {
                if (!goal) return { success: false, reason: "goal is required for agent" };
                logger.info({ goal }, `Tool: ${logPrefix} (agent)`);
                const agent = stagehand.agent();
                const result = await agent.execute({
                  instruction: goal,
                  maxSteps: 25,
                });
                const summary = typeof result === "string" ? result : JSON.stringify(result);
                return { success: true, goal, result: summary.slice(0, 4000) };
              }

              case "login": {
                if (!url) return { success: false, reason: "url is required for login" };
                const loginUrl = normalizeUrl(url);
                logger.info({ url: loginUrl }, `Tool: ${logPrefix} (login)`);
                await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
                const title = await page.evaluate(() => document.title).catch(() => "");
                // Keep the browser alive while the user enters credentials —
                // skip the idle-shutdown timer that releaseBrowser would arm.
                keepAlive = true;
                return {
                  success: true,
                  url: loginUrl,
                  title,
                  waitingForUser: true,
                  message:
                    "Login page opened in the browser window. Waiting for manual credential entry.",
                };
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Browser operation failed";
            logger.error({ error, action }, `Tool: ${logPrefix} failed`);
            if (isFatalBrowserError(message)) {
              resetBrowser();
              resetDone = true;
            }
            return { success: false, reason: message };
          } finally {
            if (acquired && !keepAlive && !resetDone) {
              releaseBrowser();
            }
          }
        },
        { timeoutMs, label: `${logPrefix}:${action}` },
      );
    },
  });
}

export interface BrowseToolOptions {
  /**
   * Whether to expose the in-browser `search` action. Callers should set
   * `false` when a standalone `webSearch` tool is registered alongside
   * browse — having two ways to search confuses the LLM, and the API path
   * is faster and cheaper. Defaults to `true` for backwards compatibility.
   */
  includeSearch?: boolean;
}

function pickActions<T extends BrowseAction>(
  base: readonly T[],
  includeSearch: boolean,
): readonly BrowseAction[] {
  return includeSearch ? base : base.filter((a) => a !== "search");
}

/**
 * Read-only browse tool for contexts that must not mutate external state
 * (e.g. watcher executor ticks). Restricted to actions that observe but never
 * send, click, type, or open interactive flows: search, visit, extract.
 */
export function createReadOnlyBrowseTool(options: BrowseToolOptions = {}) {
  const includeSearch = options.includeSearch ?? true;
  return createBrowseToolImpl({
    allowedActions: pickActions(READ_ONLY_ACTIONS, includeSearch),
    description: includeSearch
      ? "Browse the web (read-only). Search the web, visit pages, or extract structured data from the current page. Cannot click, type, take screenshots, log in, or run autonomous agents."
      : "Browse the web (read-only). Visit pages or extract structured data from the current page. Cannot click, type, take screenshots, log in, or run autonomous agents. For lookups, use `webSearch`.",
    logPrefix: "browse-readonly",
  });
}

export function createBrowseTool(
  chatId: string,
  adapter: PlatformAdapter,
  options: BrowseToolOptions = {},
) {
  const includeSearch = options.includeSearch ?? true;
  return createBrowseToolImpl({
    allowedActions: pickActions(ALL_BROWSE_ACTIONS, includeSearch),
    description: includeSearch
      ? "Browse the web. Search for information, visit pages, extract data, interact with elements, take screenshots, or complete multi-step tasks autonomously."
      : "Browse the web. Visit pages, extract data, interact with elements, take screenshots, or complete multi-step tasks autonomously. For lookups, use `webSearch`.",
    logPrefix: "browse",
    chatId,
    adapter,
  });
}
