import { z } from "zod";

// --- Parameter schema (shared between create/patch/import) ---

export const routineParameterTypes = ["string", "number", "boolean", "array", "object"] as const;

export const routineParameterSchema = z.object({
  name: z.string().min(1, "Parameter name is required"),
  type: z.enum(routineParameterTypes),
  description: z.string().min(1, "Parameter description is required"),
  required: z.boolean(),
  default: z.unknown().optional(),
});

export type RoutineParameter = z.infer<typeof routineParameterSchema>;

// --- Create ---

export const routineCreateSchema = z
  .object({
    chatId: z.string().min(1, "Chat ID is required"),
    name: z
      .string()
      .min(1, "Name is required")
      .max(100)
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
    description: z.string().min(1, "Description is required").max(500),
    prompt: z.string().min(1, "Prompt is required"),
    parameters: z.array(routineParameterSchema).default([]),
    cronSchedule: z.string().nullable().default(null),
    reportMode: z.enum(["always", "alert"]),
    purity: z.enum(["read", "action"]).default("action"),
  })
  .refine(
    (data) => {
      if (!data.cronSchedule) return true;
      const missingDefaults = data.parameters.filter((p) => p.required && p.default === undefined);
      return missingDefaults.length === 0;
    },
    {
      message: "Cron-scheduled routines require defaults for all required parameters",
      path: ["parameters"],
    },
  );

export type RoutineCreateInput = z.infer<typeof routineCreateSchema>;

// --- Patch ---

export const routinePatchSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes")
      .optional(),
    description: z.string().min(1).max(500).optional(),
    prompt: z.string().min(1).optional(),
    parameters: z.array(routineParameterSchema).optional(),
    cronSchedule: z.string().nullable().optional(),
    reportMode: z.enum(["always", "alert"]).optional(),
    purity: z.enum(["read", "action"]).optional(),
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
      message: "Cron-scheduled routines require defaults for all required parameters",
      path: ["parameters"],
    },
  );

export type RoutinePatchInput = z.infer<typeof routinePatchSchema>;

// --- Export/Import ---

export const routineImportItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
  description: z.string().min(1).max(500),
  prompt: z.string().min(1),
  parameters: z.array(routineParameterSchema).default([]),
  cronSchedule: z.string().nullable().default(null),
  reportMode: z.enum(["always", "alert"]),
  purity: z.enum(["read", "action"]).default("action"),
  enabled: z.boolean().default(true),
});

export type RoutineImportItem = z.infer<typeof routineImportItemSchema>;

export const routineExportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  count: z.number().optional(),
  routines: z.array(routineImportItemSchema).min(1, "At least one routine required"),
});

export type RoutineExportBundle = z.infer<typeof routineExportBundleSchema>;

// --- API response types ---

export interface RoutineListItem {
  id: string;
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: RoutineParameter[];
  cronSchedule: string | null;
  reportMode: "always" | "alert";
  purity: "read" | "action";
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

export interface RoutineLogItem {
  id: string;
  trigger: "cron" | "manual" | "routine";
  parentLogId?: string;
  parameters?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  summary?: string;
  startedAt: string;
  completedAt?: string;
}
