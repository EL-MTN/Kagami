import { z } from 'zod';

// gray-matter parses ISO timestamps into Date instances; coerce back to strings
// so schemas remain a single source of truth for the on-disk format.
const dateString = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v));

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
