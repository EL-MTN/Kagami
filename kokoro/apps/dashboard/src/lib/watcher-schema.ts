import { z } from "zod";

const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid ISO 8601 datetime" });

const optionalIsoDatetime = isoDatetime.optional();

// --- Create ---

export const watcherCreateSchema = z.object({
  chatId: z.string().min(1, "Chat ID is required"),
  name: z
    .string()
    .min(1, "Name is required")
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
  description: z.string().min(1, "Description is required").max(500),
  prompt: z.string().min(1, "Prompt is required"),
  cronSchedule: z.string().min(1, "Cron schedule is required"),
  expiresAt: optionalIsoDatetime,
  oneShot: z.boolean().default(false),
  maxFires: z.number().int().positive().nullable().default(null),
  cooldownMs: z.number().int().nonnegative().nullable().default(null),
});

// --- Patch ---

export const watcherPatchSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes")
    .optional(),
  description: z.string().min(1).max(500).optional(),
  prompt: z.string().min(1).optional(),
  cronSchedule: z.string().min(1).optional(),
  expiresAt: isoDatetime.nullable().optional(),
  oneShot: z.boolean().optional(),
  maxFires: z.number().int().positive().nullable().optional(),
  cooldownMs: z.number().int().nonnegative().nullable().optional(),
  snoozedUntil: isoDatetime.nullable().optional(),
  enabled: z.boolean().optional(),
});

// --- Export/Import ---

const watcherImportItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
  description: z.string().min(1).max(500),
  prompt: z.string().min(1),
  cronSchedule: z.string().min(1),
  oneShot: z.boolean().default(false),
  maxFires: z.number().int().positive().nullable().default(null),
  cooldownMs: z.number().int().nonnegative().nullable().default(null),
  expiresAt: isoDatetime.nullable().default(null),
  enabled: z.boolean().default(true),
});

export const watcherExportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().optional(),
  count: z.number().optional(),
  watchers: z.array(watcherImportItemSchema).min(1, "At least one watcher required"),
});

export type WatcherExportBundle = z.infer<typeof watcherExportBundleSchema>;

// --- API response types ---

export interface WatcherListItem {
  id: string;
  chatId: string;
  name: string;
  description: string;
  prompt: string;
  cronSchedule: string;
  enabled: boolean;
  version: number;
  fireCount: number;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  oneShot: boolean;
  maxFires: number | null;
  cooldownMs: number | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: {
    status: "running" | "completed" | "failed";
    triggered: boolean | null;
    suppressed: boolean;
    startedAt: string;
    completedAt?: string;
  };
}

export interface WatcherLogItem {
  id: string;
  trigger: "cron" | "manual";
  status: "running" | "completed" | "failed";
  triggered: boolean | null;
  suppressed: boolean;
  summary: string | null;
  newState: string | null;
  startedAt: string;
  completedAt?: string;
}
