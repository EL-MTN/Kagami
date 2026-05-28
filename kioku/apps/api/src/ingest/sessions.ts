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

interface IngestSessionInput {
  transcript: string; // raw markdown body (frontmatter + turns)
  user_id?: string; // default 'default'
  run_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

interface IngestSessionResult {
  sessionId: string;
  added: number;
  batches: number;
  failed: number; // batches that errored (embed/extraction); see consolidate
}

// Every content-bearing batch errored, so the transcript was persisted but
// no facts could be extracted. Thrown rather than returned so both the HTTP
// route (→ 500) and the MCP tool surface it as a failure the caller retries,
// instead of a silent zero-fact success that leaves an orphaned transcript.
// Re-ingest is idempotent: upsertTranscript upserts, the summary is cached,
// and surviving facts cosine-dedup.
export class IngestExtractionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly batches: number,
    readonly failed: number,
  ) {
    super(
      `ingest failed for session ${sessionId}: all ${batches} batch(es) errored, ` +
        `0 facts extracted (transcript persisted; safe to retry)`,
    );
    this.name = "IngestExtractionError";
  }
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

  const { added, batches, failed } = await consolidate(parsed, {
    user_id: input.user_id,
    run_id: input.run_id,
    agent_id: input.agent_id,
    metadata: input.metadata,
  });

  // Total failure: there were content-bearing batches and every one errored.
  // A partial failure (failed > 0 but some batches succeeded) keeps the facts
  // it got and is observable via the returned `failed` count.
  if (batches > 0 && failed === batches) {
    throw new IngestExtractionError(sessionId, batches, failed);
  }

  return { sessionId, added, batches, failed };
}
