import { z } from "zod";

// Shared zod parser for the mem0-OSS-shaped MemoryFilters payload. Routes
// and the MCP layer accept these on every read path that can prefilter.
export const FiltersSchema = z.object({
  user_id: z.string().optional(),
  run_id: z.string().optional(),
  agent_id: z.string().optional(),
  category: z.string().optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
