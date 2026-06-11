import { tool } from "ai";
import { z } from "zod";
import {
  acquireBrowser,
  releaseBrowser,
  resetBrowser,
  withBrowserLock,
} from "../../services/browser";
import { logger, runWithSpan } from "@kokoro/shared";
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

function isFatalBrowserError(message: string): boolean {
  return (
    message.includes("Target closed") ||
    message.includes("Browser closed") ||
    message.includes("timed out")
  );
}

// No inline `agent` action: a 25-step autonomous run can't fit the per-action
// timeout (which sits below the conversational turn budget), so it would always
// time out. Autonomous browsing goes through the confirmation-gated
// `browseAgent` (services/gated-actions.ts), which dispatches outside the turn.
const ALL_BROWSE_ACTIONS = ["search", "visit", "extract", "act", "screenshot", "login"] as const;
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

interface BrowseInput {
  action: BrowseAction;
  query?: string;
  url?: string;
  instruction?: string;
  offset?: number;
}

const VISIT_CHUNK_CHARS = 4000;

function createBrowseToolImpl(options: BrowseFactoryOptions) {
  const { allowedActions, description, logPrefix, chatId, adapter } = options;
  const actionEnum = z.enum(allowedActions as [BrowseAction, ...BrowseAction[]]);
  const has = (a: BrowseAction) => allowedActions.includes(a);

  // Param fields and their describes track the allowed-action set: a palette
  // without `search` must not carry a dead `query` field inviting a confused
  // call, and `url`'s describe must mention `login` only where login exists.
  const urlField = z
    .string()
    .optional()
    .describe(
      has("login") ? "URL to visit (for visit/login actions)" : "URL to visit (for visit action)",
    );
  const instructionField = z
    .string()
    .optional()
    .describe(
      has("act")
        ? "Natural language instruction (for extract/act actions)"
        : "Natural language instruction (for extract action)",
    );
  const offsetField = z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Character offset into the page text (for visit) — when a visit returns truncated:true, call again with the next offset to keep reading",
    );
  const inputSchema = has("search")
    ? z.object({
        action: actionEnum,
        query: z.string().optional().describe("Search query (for search action)"),
        url: urlField,
        instruction: instructionField,
        offset: offsetField,
      })
    : z.object({
        action: actionEnum,
        url: urlField,
        instruction: instructionField,
        offset: offsetField,
      });

  return tool({
    description,
    inputSchema,
    execute: async ({ action, query, url, instruction, offset }: BrowseInput) => {
      // Serialize browser access — parallel tool calls share one page. Every
      // action uses the default per-action timeout, which sits below the
      // conversational turn budget; long autonomous runs go through the
      // confirmation-gated `browseAgent` path, which dispatches outside the
      // turn with its own longer budget.
      return withBrowserLock(
        async () => {
          let acquired = false;
          let keepAlive = false;
          let resetDone = false;
          try {
            const stagehand = await acquireBrowser();
            acquired = true;
            const page = stagehand.context.pages()[0];

            // Span only the work, so a thrown failure marks the span "error"
            // (the catch below converts it to a {success:false} result).
            return await runWithSpan(`browse.${action}`, async () => {
              switch (action) {
                case "search": {
                  if (!query) return { success: false, reason: "query is required for search" };
                  logger.debug({ query }, `Tool: ${logPrefix} (search)`);
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
                  const start = offset ?? 0;
                  logger.debug({ url: visitUrl, offset: start }, `Tool: ${logPrefix} (visit)`);
                  await page.goto(visitUrl, { waitUntil: "domcontentloaded" });
                  const pageText = await page
                    .evaluate(() => document.body.innerText)
                    .catch(() => "");
                  return {
                    success: true,
                    url: visitUrl,
                    text: pageText.slice(start, start + VISIT_CHUNK_CHARS),
                    offset: start,
                    totalChars: pageText.length,
                    truncated: pageText.length > start + VISIT_CHUNK_CHARS,
                  };
                }

                case "extract": {
                  if (!instruction)
                    return { success: false, reason: "instruction is required for extract" };
                  logger.debug({ instruction }, `Tool: ${logPrefix} (extract)`);
                  const result = (await stagehand.extract(instruction)) as { extraction?: string };
                  return { success: true, extraction: result.extraction ?? "" };
                }

                case "act": {
                  if (!instruction)
                    return { success: false, reason: "instruction is required for act" };
                  logger.debug({ instruction }, `Tool: ${logPrefix} (act)`);
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
                    return {
                      success: false,
                      reason: "screenshot is not available in this context",
                    };
                  }
                  logger.debug(`Tool: ${logPrefix} (screenshot)`);
                  const buffer = await page.screenshot();
                  await adapter.sendPhotoBuffer(chatId, Buffer.from(buffer));
                  return { success: true, sent: true };
                }

                case "login": {
                  if (!url) return { success: false, reason: "url is required for login" };
                  const loginUrl = normalizeUrl(url);
                  logger.debug({ url: loginUrl }, `Tool: ${logPrefix} (login)`);
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
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Browser operation failed";
            logger.error({ error: error, action }, `Tool: ${logPrefix} failed`);
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
        { label: `${logPrefix}:${action}` },
      );
    },
  });
}

interface BrowseToolOptions {
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
      ? "Browse the web. Search for information, visit pages, extract data, interact with elements, or take screenshots. Purchases, form submissions, and other irreversible page actions must be approval-gated: raise requestConfirmation with `browseAgent` instead of chaining `act`."
      : "Browse the web. Visit pages, extract data, interact with elements, or take screenshots. For lookups, use `webSearch`. Purchases, form submissions, and other irreversible page actions must be approval-gated: raise requestConfirmation with `browseAgent` instead of chaining `act`.",
    logPrefix: "browse",
    chatId,
    adapter,
  });
}
