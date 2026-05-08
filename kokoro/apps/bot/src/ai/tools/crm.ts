import { tool } from "ai";
import { z } from "zod";
import {
  findPeople,
  getPersonContext,
  KizunaClientError,
  listMyFollowups,
  recentInteractions,
  type FollowupSummary,
  type InteractionSummary,
  type PersonContext,
  type PersonSummary,
} from "@kokoro/kizuna";
import { logger } from "@kokoro/shared";

type CrmToolResult<T> =
  | {
      success: true;
      data: T;
      count?: number;
      truncated?: boolean;
    }
  | {
      success: false;
      reason: string;
      degraded?: true;
    };

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "must be a 24-char hex ObjectId");
const isoDatetime = z.string().datetime({ offset: true });

const opaqueIdGuidance =
  "Returned CRM IDs are opaque tool handles. Use PersonSummary.id, personId, primaryOrgId, participant person IDs, and sourceInteractionId only for follow-up CRM tool calls or internal correlation; do not quote raw IDs back unless Eric explicitly asks.";

function clampLimit(value: number | undefined, defaultValue: number, min: number, max: number) {
  if (value === undefined || Number.isNaN(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function crmFailure(err: unknown): CrmToolResult<never> {
  if (err instanceof KizunaClientError) {
    const degraded =
      err.kind !== "http" || (err.status !== undefined && ![404].includes(err.status));
    return {
      success: false,
      reason: err.safeMessage,
      ...(degraded ? { degraded: true as const } : {}),
    };
  }
  return { success: false, reason: "CRM lookup failed", degraded: true };
}

function logFailure(toolName: string, err: unknown) {
  if (err instanceof KizunaClientError) {
    logger.warn(
      {
        tool: toolName,
        kind: err.kind,
        routeTemplate: err.routeTemplate,
        status: err.status,
      },
      `Tool: ${toolName} failed`,
    );
    return;
  }
  logger.warn({ tool: toolName }, `Tool: ${toolName} failed`);
}

export function createFindPeopleTool() {
  return tool({
    description: `Find Kizuna people by stable identity fields for disambiguation. ${opaqueIdGuidance}`,
    inputSchema: z.object({
      query: z.string().describe("Name, email, handle, or other stable identity clue."),
      limit: z.number().int().optional().describe("Number of people to return (1-20, default 10)."),
    }),
    execute: async ({ query, limit }): Promise<CrmToolResult<PersonSummary[]>> => {
      const trimmed = query.trim();
      if (!trimmed) return { success: false, reason: "query is required" };
      if (trimmed.length > 200)
        return { success: false, reason: "query must be 200 characters or less" };
      try {
        const result = await findPeople({
          query: trimmed,
          limit: clampLimit(limit, 10, 1, 20),
        });
        logger.info(
          { tool: "findPeople", count: result.items.length, truncated: Boolean(result.nextCursor) },
          "Tool: findPeople",
        );
        return {
          success: true,
          data: result.items,
          count: result.items.length,
          ...(result.nextCursor ? { truncated: true } : {}),
        };
      } catch (err) {
        logFailure("findPeople", err);
        return crmFailure(err);
      }
    },
  });
}

export function createGetPersonContextTool() {
  return tool({
    description: `Get compact Kizuna CRM context for one person: profile details, recent interactions, and open followups. ${opaqueIdGuidance}`,
    inputSchema: z.object({
      personId: objectId.describe("PersonSummary.id returned by findPeople or another CRM tool."),
    }),
    execute: async ({ personId }): Promise<CrmToolResult<PersonContext>> => {
      try {
        const data = await getPersonContext({ personId });
        logger.info(
          {
            tool: "getPersonContext",
            interactionCount: data.recentInteractions.length,
            followupCount: data.openFollowups.length,
          },
          "Tool: getPersonContext",
        );
        return { success: true, data };
      } catch (err) {
        logFailure("getPersonContext", err);
        return crmFailure(err);
      }
    },
  });
}

export function createRecentInteractionsTool() {
  return tool({
    description: `List recent Kizuna interactions for a person in event-time order. ${opaqueIdGuidance}`,
    inputSchema: z.object({
      personId: objectId.describe("PersonSummary.id returned by findPeople or another CRM tool."),
      channel: z
        .enum(["email", "calendar", "call", "in_person", "message", "manual"])
        .optional()
        .describe("Optional interaction channel filter."),
      since: isoDatetime.optional().describe("Optional ISO timestamp lower bound."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Number of interactions to return (1-50, default 20)."),
    }),
    execute: async ({
      personId,
      channel,
      since,
      limit,
    }): Promise<CrmToolResult<InteractionSummary[]>> => {
      try {
        const result = await recentInteractions({
          personId,
          channel,
          since,
          limit: clampLimit(limit, 20, 1, 50),
        });
        logger.info(
          {
            tool: "recentInteractions",
            count: result.items.length,
            truncated: Boolean(result.nextCursor),
          },
          "Tool: recentInteractions",
        );
        return {
          success: true,
          data: result.items,
          count: result.items.length,
          ...(result.nextCursor ? { truncated: true } : {}),
        };
      } catch (err) {
        logFailure("recentInteractions", err);
        return crmFailure(err);
      }
    },
  });
}

export function createListMyFollowupsTool() {
  return tool({
    description: `List Kizuna followups in Eric-relative terms: i_owe means Eric owes the person, and they_owe means the person owes Eric. ${opaqueIdGuidance}`,
    inputSchema: z.object({
      direction: z
        .enum(["i_owe", "they_owe"])
        .optional()
        .describe("Optional Eric-relative direction."),
      status: z
        .enum(["open", "done", "snoozed", "dismissed"])
        .optional()
        .describe("Followup status filter. Defaults to open."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Number of followups to return (1-50, default 50)."),
    }),
    execute: async ({ direction, status, limit }): Promise<CrmToolResult<FollowupSummary[]>> => {
      try {
        const result = await listMyFollowups({
          direction,
          status: status ?? "open",
          limit: clampLimit(limit, 50, 1, 50),
        });
        logger.info(
          {
            tool: "listMyFollowups",
            count: result.items.length,
            truncated: Boolean(result.nextCursor),
          },
          "Tool: listMyFollowups",
        );
        return {
          success: true,
          data: result.items,
          count: result.items.length,
          ...(result.nextCursor ? { truncated: true } : {}),
        };
      } catch (err) {
        logFailure("listMyFollowups", err);
        return crmFailure(err);
      }
    },
  });
}

export function createCrmTools() {
  return {
    findPeople: createFindPeopleTool(),
    getPersonContext: createGetPersonContextTool(),
    recentInteractions: createRecentInteractionsTool(),
    listMyFollowups: createListMyFollowupsTool(),
  };
}
