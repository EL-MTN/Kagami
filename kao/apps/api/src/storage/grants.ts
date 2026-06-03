import type { Db, Collection } from "mongodb";

// One document per named grant. The grant name is the natural key (unique).
// `refreshToken` is an AES-256-GCM envelope (see lib/encryption.ts); it is
// nulled on revoke rather than the row being deleted, so status history and
// the prior scope set stay inspectable.
interface GrantDoc {
  name: string;
  scopes: string[];
  refreshToken: string | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
}

function collection(db: Db): Collection<GrantDoc> {
  return db.collection<GrantDoc>("grants");
}

export async function ensureGrantIndexes(db: Db): Promise<void> {
  await collection(db).createIndex({ name: 1 }, { unique: true });
}

export async function getGrant(db: Db, name: string): Promise<GrantDoc | null> {
  return collection(db).findOne({ name });
}

export async function listGrants(db: Db): Promise<GrantDoc[]> {
  return collection(db).find({}).toArray();
}

export async function upsertGrant(
  db: Db,
  input: { name: string; scopes: string[]; refreshToken: string },
): Promise<void> {
  const now = new Date();
  await collection(db).updateOne(
    { name: input.name },
    {
      $set: {
        scopes: input.scopes,
        refreshToken: input.refreshToken,
        grantedAt: now,
        revokedAt: null,
        updatedAt: now,
      },
      $setOnInsert: { name: input.name },
    },
    { upsert: true },
  );
}

// Soft revoke: keep the row (name/scopes/grantedAt remain inspectable), drop
// the secret, stamp revokedAt. A later re-consent upserts a fresh token and
// clears revokedAt.
export async function revokeGrant(db: Db, name: string): Promise<boolean> {
  const res = await collection(db).updateOne(
    { name },
    { $set: { refreshToken: null, revokedAt: new Date(), updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}
