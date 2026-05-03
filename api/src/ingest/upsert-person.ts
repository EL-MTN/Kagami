import { Types } from 'mongoose';
import { Person } from '../db/models/Person.js';

export type UpsertPersonInput = {
  email: string;
  displayName?: string | null;
  occurredAt: Date; // used as firstSeen if creating
};

export type UpsertPersonResult = {
  personId: Types.ObjectId;
  created: boolean;
  tombstonedSuppressed: boolean; // true when linked to a tombstoned person we won't mutate
};

/**
 * Find-or-create a person for an email seen during ingest.
 *
 * Spec invariants:
 * - suppressReingest=true → return existing personId; do not mutate the row
 *   (no clearing deletedAt, no field updates). Interactions still link.
 * - suppressReingest=false on a tombstoned person → "rare; e.g. after a
 *   manual undelete". Treat as a normal upsert: clear deletedAt + update.
 * - Match on lower-cased primaryEmail.
 */
export async function upsertPerson(
  input: UpsertPersonInput,
): Promise<UpsertPersonResult> {
  const email = input.email.toLowerCase().trim();
  const displayName = (input.displayName ?? '').trim() || email;

  const existing = await Person.findOne({ primaryEmail: email });

  if (existing) {
    if (existing.get('suppressReingest')) {
      return {
        personId: existing._id as Types.ObjectId,
        created: false,
        tombstonedSuppressed: existing.get('deletedAt') != null,
      };
    }

    const updates: Record<string, unknown> = {};

    // If the existing display name is missing or just the email, replace it.
    const currentName = (existing.get('displayName') as string | undefined) ?? '';
    if (!currentName || currentName === email) {
      if (displayName !== email) updates.displayName = displayName;
    }

    if (existing.get('deletedAt')) {
      // suppressReingest=false on a tombstoned row → un-tombstone.
      updates.deletedAt = null;
    }

    if (Object.keys(updates).length > 0) {
      await Person.updateOne({ _id: existing._id }, { $set: updates });
    }

    return {
      personId: existing._id as Types.ObjectId,
      created: false,
      tombstonedSuppressed: false,
    };
  }

  const created = await Person.create({
    displayName,
    primaryEmail: email,
    emails: [email],
    firstSeen: input.occurredAt,
    source: 'gmail-sync',
  });
  return {
    personId: created._id as Types.ObjectId,
    created: true,
    tombstonedSuppressed: false,
  };
}
