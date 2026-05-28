import { Types } from "mongoose";
import {
  Interaction,
  type InteractionChannel,
  type InteractionParticipant,
  type InteractionStatus,
} from "./models/Interaction.js";
import { Person } from "./models/Person.js";
import type { Source } from "./models/base.js";

export type RecordInteractionInput = {
  occurredAt: Date;
  channel: InteractionChannel;
  title: string;
  body?: string;
  participants: InteractionParticipant[];
  context?: string[];
  location?: string;
  attachments?: Array<{
    name: string;
    mimeType?: string;
    size?: number;
    ref?: string;
  }>;
  sourceRef?: { provider: "gmail" | "gcal"; id: string } | null;
  source: Source;
  sourceVersion?: string;
  status?: InteractionStatus;
};

type RecordOpts = {
  /**
   * If true, swallow E11000 dup-key errors raised by the unique partial index
   * on sourceRef. Returns null in that case. Used by ingest workers to make
   * replays idempotent.
   */
  skipIfDuplicate?: boolean;
};

/**
 * The only path that inserts into `interactions`. Maintains the
 * `lastInteractionAt` invariant on every linked person via $max.
 *
 * Returns null only when `skipIfDuplicate` is true and the unique sourceRef
 * partial index rejected the insert.
 */
export async function recordInteraction(input: RecordInteractionInput, opts: RecordOpts = {}) {
  let created;
  try {
    created = await Interaction.create(input);
  } catch (err) {
    if (
      opts.skipIfDuplicate &&
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return null;
    }
    throw err;
  }
  const participants = created.participants ?? [];
  await touchLastInteraction(
    participants.map((p) => p.personId),
    created.occurredAt,
  );
  return created;
}

async function touchLastInteraction(personIds: Types.ObjectId[], occurredAt: Date): Promise<void> {
  const unique = [...new Set(personIds.map((id) => id.toHexString()))].map(
    (s) => new Types.ObjectId(s),
  );
  if (unique.length === 0) return;
  await Person.updateMany({ _id: { $in: unique } }, { $max: { lastInteractionAt: occurredAt } });
}

/**
 * Upsert an interaction by its `sourceRef`. Used by the Calendar ingest worker
 * to reconcile edits to existing events: title/time/location/status get
 * overwritten, the participants array is replaced wholesale.
 *
 * `lastInteractionAt` is only bumped when the upserted interaction is active —
 * cancelled events should not register as a recent touchpoint.
 */
export async function upsertInteractionBySourceRef(input: RecordInteractionInput) {
  if (!input.sourceRef) {
    throw new Error("upsertInteractionBySourceRef requires a sourceRef");
  }
  const filter = {
    "sourceRef.provider": input.sourceRef.provider,
    "sourceRef.id": input.sourceRef.id,
  };
  const set: Record<string, unknown> = {
    occurredAt: input.occurredAt,
    channel: input.channel,
    title: input.title,
    body: input.body ?? "",
    participants: input.participants,
    status: input.status ?? "active",
    sourceRef: input.sourceRef,
    source: input.source,
  };
  if (input.location !== undefined) set.location = input.location;
  else set.location = null;
  if (input.attachments !== undefined) set.attachments = input.attachments;
  if (input.context !== undefined) set.context = input.context;
  if (input.sourceVersion !== undefined) set.sourceVersion = input.sourceVersion;

  const doc = await Interaction.findOneAndUpdate(
    filter,
    { $set: set },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
  if (!doc) throw new Error("upsert returned no document");

  const status = doc.status ?? "active";
  if (status === "active") {
    const participants = doc.participants ?? [];
    await touchLastInteraction(
      participants.map((p) => p.personId),
      doc.occurredAt,
    );
  }
  return doc;
}
