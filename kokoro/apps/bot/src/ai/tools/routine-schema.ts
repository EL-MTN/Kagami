import { z } from "zod";

/**
 * Canonical Zod shape for a routine parameter. Lives in its own leaf module
 * (zod-only, no other imports) so every place that validates routine
 * parameters — `manageRoutines` (./routines), the gated `createRoutine`
 * dispatcher (../../services/gated-actions), and the `proposeRoutine` tool
 * (./routine-proposals) — shares one definition without forming an import
 * cycle through the routine executor.
 */
export const parameterSchema = z.object({
  name: z.string().describe("Parameter name"),
  type: z
    .enum(["string", "number", "boolean", "array", "object"])
    .describe("Parameter type — use array for lists, object for key-value maps"),
  description: z.string().describe("What this parameter is for"),
  required: z.boolean().describe("Whether this parameter must be provided"),
  default: z
    .unknown()
    .optional()
    .describe("Default value (required params with cron schedules must have defaults)"),
});
