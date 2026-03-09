import { tool } from "ai";
import { z } from "zod";
import {
  acquireBrowser,
  releaseBrowser,
  resetBrowser,
  withBrowserLock,
} from "../../services/browser.js";
import { logger } from "@mashiro/shared";
import type { PlatformAdapter } from "@mashiro/shared";

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

export function createBrowseTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description:
      "Browse the web. Search for information, visit pages, extract data, interact with elements, take screenshots, or complete multi-step tasks autonomously.",
    parameters: z.object({
      action: z.enum(["search", "visit", "extract", "act", "screenshot", "agent", "login"]),
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
      // Serialize browser access — parallel tool calls share one page
      return withBrowserLock(async () => {
        try {
          const stagehand = await acquireBrowser();
          const page = stagehand.context.pages()[0];

          switch (action) {
            case "search": {
              if (!query) return { success: false, reason: "query is required for search" };
              logger.info({ query }, "Tool: browse (search)");
              const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
              await page.goto(searchUrl);
              const results = await stagehand.extract(
                "Extract all search results with their title, URL, and snippet/description text",
                SearchResultSchema,
              );
              releaseBrowser();
              return { success: true, query, results: results.slice(0, 10) };
            }

            case "visit": {
              if (!url) return { success: false, reason: "url is required for visit" };
              const visitUrl = normalizeUrl(url);
              logger.info({ url: visitUrl }, "Tool: browse (visit)");
              await page.goto(visitUrl, { waitUntil: "domcontentloaded" });
              const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
              const truncated = pageText.slice(0, 4000);
              releaseBrowser();
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
              logger.info({ instruction }, "Tool: browse (extract)");
              const result = (await stagehand.extract(instruction)) as { extraction?: string };
              releaseBrowser();
              return { success: true, extraction: result.extraction ?? "" };
            }

            case "act": {
              if (!instruction)
                return { success: false, reason: "instruction is required for act" };
              logger.info({ instruction }, "Tool: browse (act)");
              await stagehand.act(instruction);
              releaseBrowser();
              return { success: true, performed: instruction };
            }

            case "screenshot": {
              logger.info("Tool: browse (screenshot)");
              const buffer = await page.screenshot();
              await adapter.sendPhotoBuffer(chatId, Buffer.from(buffer));
              releaseBrowser();
              return { success: true, sent: true };
            }

            case "agent": {
              if (!goal) return { success: false, reason: "goal is required for agent" };
              logger.info({ goal }, "Tool: browse (agent)");
              const agent = stagehand.agent();
              const result = await agent.execute({
                instruction: goal,
                maxSteps: 25,
              });
              const summary = typeof result === "string" ? result : JSON.stringify(result);
              releaseBrowser();
              return { success: true, goal, result: summary.slice(0, 4000) };
            }

            case "login": {
              if (!url) return { success: false, reason: "url is required for login" };
              const loginUrl = normalizeUrl(url);
              logger.info({ url: loginUrl }, "Tool: browse (login)");
              await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
              const title = await page.evaluate(() => document.title).catch(() => "");
              // Don't release browser — keep it alive while user logs in
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
          logger.error({ error, action }, "Tool: browse failed");

          // Reset singleton on browser crash so next call re-inits
          if (message.includes("Target closed") || message.includes("Browser closed")) {
            resetBrowser();
          }

          return { success: false, reason: message };
        }
      });
    },
  });
}
