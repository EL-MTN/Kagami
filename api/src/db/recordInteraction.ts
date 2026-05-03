import { Types } from 'mongoose';
import { Interaction } from './models/Interaction.js';
import { Person } from './models/Person.js';
import type { Source } from './models/base.js';

export type RecordInteractionInput = {
  occurredAt: Date;
  channel: string;
  title: string;
  body?: string;
  participants: Array<{ personId: Types.ObjectId; role: string }>;
  context?: string[];
  location?: string;
  attachments?: Array<{
    name: string;
    mimeType?: string;
    size?: number;
    ref?: string;
  }>;
  sourceRef?: { provider: 'gmail' | 'gcal'; id: string } | null;
  source: Source;
  sourceVersion?: string;
  status?: 'active' | 'cancelled';
};

/**
 * The only path that inserts into `interactions`. Maintains the
 * `lastInteractionAt` invariant on every linked person via $max.
 */
export async function recordInteraction(input: RecordInteractionInput) {
  const created = await Interaction.create(input);
  const participants = (created.get('participants') as unknown as
    | Array<{ personId: Types.ObjectId }>
    | undefined) ?? [];
  await touchLastInteraction(
    participants.map((p) => p.personId),
    created.get('occurredAt') as Date,
  );
  return created;
}

async function touchLastInteraction(
  personIds: Types.ObjectId[],
  occurredAt: Date,
): Promise<void> {
  const unique = [...new Set(personIds.map((id) => id.toHexString()))].map(
    (s) => new Types.ObjectId(s),
  );
  if (unique.length === 0) return;
  await Person.updateMany(
    { _id: { $in: unique } },
    { $max: { lastInteractionAt: occurredAt } },
  );
}
