import { z } from "zod";

// --- Parameter schema (shared between create/patch/import) ---

export const skillParameterTypes = ["string", "number", "boolean", "array", "object"] as const;

export const skillParameterSchema = z.object({
  name: z.string().min(1, "Parameter name is required"),
  type: z.enum(skillParameterTypes),
  description: z.string().min(1, "Parameter description is required"),
  required: z.boolean(),
  default: z.unknown().optional(),
});

export type SkillParameter = z.infer<typeof skillParameterSchema>;

// --- Create ---

export const skillCreateSchema = z
  .object({
    chatId: z.string().min(1, "Chat ID is required"),
    name: z
      .string()
      .min(1, "Name is required")
      .max(100)
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
    description: z.string().min(1, "Description is required").max(500),
    prompt: z.string().min(1, "Prompt is required"),
    parameters: z.array(skillParameterSchema).default([]),
    cronSchedule: z.string().nullable().default(null),
    reportMode: z.enum(["always", "alert"]),
  })
  .refine(
    (data) => {
      if (!data.cronSchedule) return true;
      const missingDefaults = data.parameters.filter((p) => p.required && p.default === undefined);
      return missingDefaults.length === 0;
    },
    {
      message: "Cron-scheduled skills require defaults for all required parameters",
      path: ["parameters"],
    },
  );

export type SkillCreateInput = z.infer<typeof skillCreateSchema>;

// --- Patch ---

export const skillPatchSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes")
      .optional(),
    description: z.string().min(1).max(500).optional(),
    prompt: z.string().min(1).optional(),
    parameters: z.array(skillParameterSchema).optional(),
    cronSchedule: z.string().nullable().optional(),
    reportMode: z.enum(["always", "alert"]).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) => {
      // Only validate if both cron and parameters are present in the patch
      if (data.cronSchedule === undefined || data.cronSchedule === null) return true;
      if (!data.parameters) return true;
      const missingDefaults = data.parameters.filter((p) => p.required && p.default === undefined);
      return missingDefaults.length === 0;
    },
    {
      message: "Cron-scheduled skills require defaults for all required parameters",
      path: ["parameters"],
    },
  );

export type SkillPatchInput = z.infer<typeof skillPatchSchema>;

// --- Export/Import ---

export const skillImportItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
  description: z.string().min(1).max(500),
  prompt: z.string().min(1),
  parameters: z.array(skillParameterSchema).default([]),
  cronSchedule: z.string().nullable().default(null),
  reportMode: z.enum(["always", "alert"]),
  enabled: z.boolean().default(true),
});

export type SkillImportItem = z.infer<typeof skillImportItemSchema>;

export const skillExportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  count: z.number().optional(),
  skills: z.array(skillImportItemSchema).min(1, "At least one skill required"),
});

export type SkillExportBundle = z.infer<typeof skillExportBundleSchema>;

// --- API response types ---

export interface SkillListItem {
  id: string;
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: SkillParameter[];
  cronSchedule: string | null;
  reportMode: "always" | "alert";
  enabled: boolean;
  version: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: {
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt?: string;
  };
}

export interface SkillLogItem {
  id: string;
  trigger: "cron" | "manual" | "skill";
  parentLogId?: string;
  parameters?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: string;
  completedAt?: string;
}
