import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import {
  getSkillByName,
  isSkillRecentlyDeclined,
  listEnabledSkillsForChat,
  recordSkillUsed,
  type ISkill,
} from "@kokoro/db";
import { logger } from "@kokoro/shared";
import type { PlatformAdapter } from "@kokoro/shared";
import { raiseGuardedProposal } from "./proposal-guard";
import { OWNER } from "../persona";

const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers, and dashes.");

const shortListSchema = z.array(z.string().min(1).max(140)).max(20).optional();

function termsFor(query: string | undefined): string[] {
  return query
    ? query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0)
    : [];
}

function matchesQuery(skill: ISkill, terms: string[]): boolean {
  const haystack = [skill.name, skill.description, skill.body, ...skill.triggers, ...skill.tags]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function createSearchSkillsTool(chatId: string) {
  return tool({
    description:
      "Search available skills by keyword. Skills are reusable procedural knowledge/context, not executable routines. Call with no query to list all enabled skills.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe(
          "Search keywords to match against skill names, descriptions, triggers, tags, and body.",
        ),
    }),
    execute: async ({ query }) => {
      try {
        const skills = await listEnabledSkillsForChat(chatId);
        if (skills.length === 0) {
          return { success: true, count: 0, skills: [], hint: "No skills exist yet" };
        }

        const terms = termsFor(query);
        const matches = terms.length > 0 ? skills.filter((s) => matchesQuery(s, terms)) : skills;

        logger.debug(
          { chatId, query, total: skills.length, matched: matches.length },
          "Tool: searchSkills",
        );

        return {
          success: true,
          count: matches.length,
          skills: matches.map((s) => ({
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            tags: s.tags,
            source: s.source,
            version: s.version,
          })),
        };
      } catch (error) {
        logger.error({ error, chatId }, "Tool: searchSkills failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Skill search failed",
        };
      }
    },
  });
}

export function createReadSkillTool(chatId: string) {
  return tool({
    description:
      "Read the full body of an enabled skill by name. Use this before applying a skill's detailed procedure.",
    inputSchema: z.object({
      name: skillNameSchema.describe("Skill name, e.g. 'followup-style'."),
    }),
    execute: async ({ name }) => {
      try {
        const skill = await getSkillByName(chatId, name);
        if (!skill || !skill.enabled) {
          return { success: false, reason: `Skill "${name}" not found or disabled` };
        }

        await recordSkillUsed(skill._id.toString(), chatId).catch((error) => {
          logger.warn({ error, chatId, name }, "Failed to record skill usage");
        });

        logger.debug({ chatId, name }, "Tool: readSkill");
        return {
          success: true,
          skill: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            triggers: skill.triggers,
            tags: skill.tags,
            source: skill.source,
            version: skill.version,
            linkedRoutineIds: skill.linkedRoutineIds.map((id) => id.toString()),
          },
        };
      } catch (error) {
        logger.error({ error, chatId, name }, "Tool: readSkill failed");
        return {
          success: false,
          reason: error instanceof Error ? error.message : "Skill read failed",
        };
      }
    },
  });
}

export function computeSkillProposalSignature(name: string, body: string): string {
  const normName = name.trim().toLowerCase().replace(/\s+/g, " ");
  const bodyHash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return `${normName}#${bodyHash}`;
}

function buildSkillProposalPrompt(draft: {
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
}): string {
  const lines = [
    `Save this as a reusable skill? (procedural context, not automation)`,
    ``,
    `**${draft.name}** — ${draft.description}`,
  ];
  if (draft.triggers.length > 0) {
    lines.push(``, `Triggers: ${draft.triggers.join(", ")}`);
  }
  if (draft.tags.length > 0) {
    lines.push(`Tags: ${draft.tags.join(", ")}`);
  }
  lines.push(``, draft.body);
  return lines.join("\n");
}

export function createProposeSkillTool(chatId: string, adapter: PlatformAdapter) {
  return tool({
    description: `Offer to save a reusable skill: durable procedural knowledge, preferences, heuristics, or operating instructions that should be loaded as context later. This does not create automation and does not execute anything. Use only on a natural closing turn, at most one at a time, when the lesson is broadly reusable and not a one-off fact. ${OWNER} gets a tap-to-approve bubble; the skill is created only if he approves.`,
    inputSchema: z.object({
      name: skillNameSchema.describe(
        "Short unique skill name, lowercase with dashes, e.g. 'meeting-followup-style'.",
      ),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("One line describing when the skill is useful."),
      body: z
        .string()
        .min(1)
        .max(6000)
        .describe(
          "The reusable procedural guidance. Write it as instructions Mashiro can apply later; don't include transient facts.",
        ),
      triggers: shortListSchema.describe(
        "Optional phrases or situations that should cue this skill.",
      ),
      tags: shortListSchema.describe(
        "Optional short labels for search and dashboard organization.",
      ),
    }),
    execute: async ({ name, description, body, triggers, tags }) => {
      try {
        const normalizedTriggers = triggers ?? [];
        const normalizedTags = tags ?? [];
        const signature = computeSkillProposalSignature(name, body);

        const result = await raiseGuardedProposal({
          chatId,
          adapter,
          signature,
          isDeclined: isSkillRecentlyDeclined,
          declinedReason: `${OWNER} declined a similar skill recently`,
          summary: `Save skill "${name}"`,
          promptText: buildSkillProposalPrompt({
            name,
            description,
            body,
            triggers: normalizedTriggers,
            tags: normalizedTags,
          }),
          origin: "conversation",
          action: {
            tool: "createSkill",
            args: {
              signature,
              name,
              description,
              body,
              triggers: normalizedTriggers,
              tags: normalizedTags,
            },
          },
        });
        if (!result.proposed) {
          return { proposed: false, reason: result.reason };
        }

        logger.debug({ chatId, name, confirmationId: result.confirmationId }, "Tool: proposeSkill");
        return {
          proposed: true,
          confirmationId: result.confirmationId,
          message: `Skill-save prompt sent. Stop here — don't call this again this turn. ${OWNER} will tap Approve or Deny.`,
        };
      } catch (error) {
        logger.error({ error, chatId }, "Tool: proposeSkill failed");
        return {
          proposed: false,
          reason: error instanceof Error ? error.message : "Failed to raise skill proposal",
        };
      }
    },
  });
}
