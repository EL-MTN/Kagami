import { z } from 'zod';

// gray-matter parses ISO timestamps into Date instances; coerce back to strings
// so schemas remain a single source of truth for the on-disk format.
const dateString = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v));

export const Candidate = z.object({
  entity_name: z.string(),
  type: z.string(),
  aliases_seen: z.array(z.string()),
  headline: z.string(),
  quote: z.string(),
  turn_id: z.string(),
  date: dateString,
});
export type Candidate = z.infer<typeof Candidate>;

export const ExtractionResult = z.object({
  candidates: z.array(Candidate),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const EntityFrontmatter = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  type: z.string(),
  anchor: z.string().default(''),
  updated: dateString,
});
export type EntityFrontmatter = z.infer<typeof EntityFrontmatter>;

export const Observation = z.object({
  date: dateString,
  headline: z.string(),
  quote: z.string(),
  source: z.string(),
});
export type Observation = z.infer<typeof Observation>;

export const TranscriptFrontmatter = z.object({
  id: z.string(),
  started_at: dateString,
});
export type TranscriptFrontmatter = z.infer<typeof TranscriptFrontmatter>;

export const Turn = z.object({
  id: z.string(),
  role: z.string(),
  text: z.string(),
});
export type Turn = z.infer<typeof Turn>;

export const Transcript = z.object({
  frontmatter: TranscriptFrontmatter,
  turns: z.array(Turn),
});
export type Transcript = z.infer<typeof Transcript>;

export const LogEntry = z.object({
  ts: z.string(),
  entity_id: z.string(),
  observation: Observation,
  source_turn: z.string(),
  candidate_subject: z.string(),
  decision: z.enum(['matched', 'created', 'duplicated']),
});
export type LogEntry = z.infer<typeof LogEntry>;
