import { tool } from "ai";
import { z } from "zod";
import {
  createFollowup,
  findPeople,
  getPersonContext,
  KizunaClientError,
  listMyFollowups,
  logInteraction,
  recentInteractions,
  resolveFollowup,
  updatePerson,
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

// ─── Write tools ─────────────────────────────────────────────────────────────
//
// Each write tool MUST be wrapped in `requestConfirmation` so Goshujin-sama
// approves before the mutation lands. The tools below still execute their
// underlying client call when invoked directly — fail-open envelopes on
// KizunaClientError mirror the read tools — but they are listed in
// GATED_TOOL_NAMES so the gated dispatcher is the canonical run path.

const writeGateGuidance =
  "MUST be wrapped in requestConfirmation — call requestConfirmation({ summary, action: { tool, args } }) instead of invoking this tool directly.";

const participantRole = z.enum(["from", "to", "cc", "attendee", "subject"]);
const interactionChannel = z.enum(["email", "calendar", "call", "in_person", "message", "manual"]);
const followupStatus = z.enum(["open", "done", "snoozed", "dismissed"]);
const followupDirection = z.enum(["i_owe", "they_owe"]);
const birthday = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD or --MM-DD"),
  z.string().regex(/^--\d{2}-\d{2}$/, "must be YYYY-MM-DD or --MM-DD"),
]);

export function createLogInteractionTool() {
  return tool({
    description: `Log a Kizuna interaction with one or more people (call, in_person meeting, manual message log, etc). ${writeGateGuidance} ${opaqueIdGuidance}`,
    inputSchema: z.object({
      occurredAt: isoDatetime.describe("ISO 8601 timestamp the interaction happened at."),
      channel: interactionChannel.describe(
        "Channel for this interaction. Gmail/calendar ingest already auto-logs email/calendar entries, so concierge writes are almost always call/in_person/message/manual.",
      ),
      title: z.string().min(1).max(200).describe("Short title shown on Kizuna's timeline."),
      body: z
        .string()
        .max(8000)
        .optional()
        .describe("Optional longer narrative — what was discussed, decisions, follow-ups noted."),
      participants: z
        .array(z.object({ personId: objectId, role: participantRole }))
        .min(1)
        .describe(
          "Each personId is a PersonSummary.id. role is from/to/cc/attendee/subject from Goshujin-sama's perspective.",
        ),
      context: z
        .array(z.string().min(1).max(80))
        .max(20)
        .optional()
        .describe("Optional context tags (e.g. 'work', 'side-project')."),
      location: z.string().max(400).optional().describe("Optional location string."),
    }),
    execute: async (input): Promise<CrmToolResult<InteractionSummary>> => {
      try {
        const data = await logInteraction(input);
        logger.info(
          {
            tool: "logInteraction",
            channel: input.channel,
            participants: input.participants.length,
          },
          "Tool: logInteraction",
        );
        return { success: true, data };
      } catch (err) {
        logFailure("logInteraction", err);
        return crmFailure(err);
      }
    },
  });
}

export function createCreateFollowupTool() {
  return tool({
    description: `Create a Kizuna followup. direction is Eric-relative: i_owe means Eric owes the person, they_owe means the person owes Eric. ${writeGateGuidance} ${opaqueIdGuidance}`,
    inputSchema: z.object({
      personId: objectId.describe("PersonSummary.id from a CRM tool."),
      direction: followupDirection.describe(
        "i_owe = Eric owes the person; they_owe = the person owes Eric.",
      ),
      reason: z.string().min(1).max(400).describe("Short reason — what's owed."),
      dueAt: isoDatetime
        .optional()
        .describe("Optional ISO 8601 due date. Omit for an open-ended followup."),
      sourceInteractionId: objectId
        .optional()
        .describe("Optional InteractionSummary.id this followup stems from."),
    }),
    execute: async (input): Promise<CrmToolResult<FollowupSummary>> => {
      try {
        const data = await createFollowup(input);
        logger.info(
          { tool: "createFollowup", direction: input.direction, hasDue: Boolean(input.dueAt) },
          "Tool: createFollowup",
        );
        return { success: true, data };
      } catch (err) {
        logFailure("createFollowup", err);
        return crmFailure(err);
      }
    },
  });
}

export function createResolveFollowupTool() {
  return tool({
    description: `Resolve (or re-open) a Kizuna followup — set status to done/snoozed/dismissed. Reuse the same tool to reopen by passing status=open. ${writeGateGuidance} ${opaqueIdGuidance}`,
    inputSchema: z.object({
      followupId: objectId.describe("FollowupSummary.id from listMyFollowups or getPersonContext."),
      status: followupStatus.describe(
        "Target status — done when complete, snoozed/dismissed to clear without completion, open to reopen.",
      ),
      dueAt: isoDatetime
        .optional()
        .describe("Optional new ISO 8601 due date — useful when snoozing."),
      reason: z.string().min(1).max(400).optional().describe("Optional updated reason text."),
    }),
    execute: async (input): Promise<CrmToolResult<FollowupSummary>> => {
      try {
        const data = await resolveFollowup(input);
        logger.info({ tool: "resolveFollowup", status: input.status }, "Tool: resolveFollowup");
        return { success: true, data };
      } catch (err) {
        logFailure("resolveFollowup", err);
        return crmFailure(err);
      }
    },
  });
}

export function createUpdatePersonTool() {
  return tool({
    description: `Update a Kizuna person profile. Only the fields you pass are changed; omit unchanged fields. ${writeGateGuidance} ${opaqueIdGuidance}`,
    inputSchema: z
      .object({
        personId: objectId.describe("PersonSummary.id from a CRM tool."),
        displayName: z.string().min(1).optional(),
        primaryEmail: z.string().email().optional(),
        primaryOrgId: objectId.optional(),
        relationship: z.string().max(2000).optional().describe("Free-form relationship narrative."),
        emails: z.array(z.string().email().max(254)).max(20).optional(),
        phones: z.array(z.string().min(1).max(40)).max(20).optional(),
        handles: z
          .record(z.string().min(1).max(40), z.string().min(1).max(80))
          .optional()
          .describe("Map of provider → handle, e.g. { telegram: '@sarah' }."),
        tags: z.array(z.string().min(1).max(80)).max(30).optional(),
        birthday: birthday.optional().describe("YYYY-MM-DD or --MM-DD (no year known)."),
        notes: z.string().max(8000).optional(),
      })
      .refine((v) => Object.keys(v).some((k) => k !== "personId"), {
        message: "updatePerson requires at least one field to change",
      }),
    execute: async (input): Promise<CrmToolResult<PersonSummary>> => {
      try {
        const data = await updatePerson(input);
        logger.info(
          {
            tool: "updatePerson",
            fields: Object.keys(input).filter((k) => k !== "personId"),
          },
          "Tool: updatePerson",
        );
        return { success: true, data };
      } catch (err) {
        logFailure("updatePerson", err);
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

export function createCrmWriteTools() {
  return {
    logInteraction: createLogInteractionTool(),
    createFollowup: createCreateFollowupTool(),
    resolveFollowup: createResolveFollowupTool(),
    updatePerson: createUpdatePersonTool(),
  };
}
