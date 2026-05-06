import { parseTranscript } from "./transcript.js";
import { consolidate } from "./consolidate.js";
import { upsertTranscript } from "../storage/transcripts.js";

// Session ingest. Accepts a raw transcript string (matter front-matter
// + `## t-N <role>` headings), persists the parsed transcript to the
// `transcripts` collection so it can be replayed without touching disk,
// and runs the transcript-batch fact extraction.
//
// Concurrent callers are safe: writes go through appendFacts (unique-hash
// dedup) and upsertEntitiesFromFacts (atomic per-entity upserts).

export interface IngestSessionInput {
  transcript: string; // raw markdown body (frontmatter + turns)
  user_id?: string; // default 'default'
  run_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestSessionResult {
  sessionId: string;
  added: number;
  batches: number;
}

export async function ingestSessionFromString(
  input: IngestSessionInput,
): Promise<IngestSessionResult> {
  const parsed = parseTranscript(input.transcript);
  const sessionId = parsed.frontmatter.id;

  // Persist the parsed transcript to Mongo before extraction so a
  // re-ingest of the same session can read it back without the caller
  // re-supplying the body.
  await upsertTranscript({
    transcript: parsed,
    user_id: input.user_id,
    run_id: input.run_id,
    agent_id: input.agent_id,
  });

  const { added, batches } = await consolidate(parsed, {
    user_id: input.user_id,
    run_id: input.run_id,
    agent_id: input.agent_id,
    metadata: input.metadata,
  });

  return { sessionId, added, batches };
}
