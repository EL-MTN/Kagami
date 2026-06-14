import { z } from "zod";

export const skillSources = ["manual", "distilled", "imported"] as const;

const chatIdSchema = z.string().min(1, "Chat ID is required");

const skillNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(64)
  .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes");

const listFieldSchema = z.array(z.string().min(1).max(140)).max(20).default([]);
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid routine ID");

export const skillCreateSchema = z.object({
  chatId: chatIdSchema,
  name: skillNameSchema,
  description: z.string().min(1, "Description is required").max(500),
  body: z.string().min(1, "Body is required").max(6000),
  triggers: listFieldSchema,
  tags: listFieldSchema,
  enabled: z.boolean().default(true),
  source: z.enum(skillSources).default("manual"),
  linkedRoutineIds: z.array(objectIdSchema).default([]),
});

const skillPackageItemSchema = z.object({
  chatId: chatIdSchema.optional(),
  name: skillNameSchema,
  description: z.string().min(1, "Description is required").max(500),
  body: z.string().min(1, "Body is required").max(6000),
  triggers: listFieldSchema,
  tags: listFieldSchema,
  enabled: z.boolean().default(true),
});

export const skillPackageBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  count: z.number().optional(),
  skills: z.array(skillPackageItemSchema),
});

export type SkillPackageBundle = z.infer<typeof skillPackageBundleSchema>;

export const skillPatchSchema = z.object({
  name: skillNameSchema.optional(),
  description: z.string().min(1).max(500).optional(),
  body: z.string().min(1).max(6000).optional(),
  triggers: z.array(z.string().min(1).max(140)).max(20).optional(),
  tags: z.array(z.string().min(1).max(140)).max(20).optional(),
  enabled: z.boolean().optional(),
  source: z.enum(skillSources).optional(),
  linkedRoutineIds: z.array(objectIdSchema).optional(),
  // The version the editor loaded; the PATCH lands only if the skill is still
  // there, so a stale or racing save returns 409 instead of clobbering an
  // intervening edit (and losing its history snapshot).
  expectedVersion: z.number().int().nonnegative().optional(),
});

export interface SkillListItem {
  id: string;
  chatId: string;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  enabled: boolean;
  source: (typeof skillSources)[number];
  linkedRoutineIds: string[];
  version: number;
  lastUsedAt: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export const skillRevisionReasons = [
  "refine",
  "merge",
  "manual-edit",
  "rollback",
  "import",
] as const;

export interface SkillRevisionItem {
  version: number;
  name: string;
  description: string;
  body: string;
  triggers: string[];
  tags: string[];
  reason: (typeof skillRevisionReasons)[number];
  actor: "curator" | "dashboard" | "system";
  note: string | null;
  takenAt: string;
}
