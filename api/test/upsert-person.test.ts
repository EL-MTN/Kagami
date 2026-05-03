import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Person } from '../src/db/models/Person.js';
import { upsertPerson } from '../src/ingest/upsert-person.js';
import { startHarness, type TestHarness } from './helpers/harness.js';

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

afterEach(async () => {
  await Person.deleteMany({});
});

describe('upsertPerson', () => {
  const occurredAt = new Date('2026-01-15T12:00:00Z');

  it('creates a new person with source=gmail-sync', async () => {
    const r = await upsertPerson({
      email: 'Sarah@Acme.com',
      displayName: 'Sarah Connor',
      occurredAt, source: 'gmail-sync',
    });
    expect(r.created).toBe(true);
    const doc = await Person.findById(r.personId).lean();
    expect(doc).toMatchObject({
      displayName: 'Sarah Connor',
      primaryEmail: 'sarah@acme.com',
      emails: ['sarah@acme.com'],
      source: 'gmail-sync',
      suppressReingest: false,
    });
  });

  it('returns existing personId when email already known', async () => {
    const a = await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Sarah',
      occurredAt, source: 'gmail-sync',
    });
    const b = await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Sarah Connor',
      occurredAt, source: 'gmail-sync',
    });
    expect(b.created).toBe(false);
    expect(b.personId.toHexString()).toBe(a.personId.toHexString());
  });

  it('upgrades displayName when previous was just the email', async () => {
    await upsertPerson({
      email: 'sarah@acme.com',
      displayName: '',
      occurredAt, source: 'gmail-sync',
    });
    await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Sarah Connor',
      occurredAt, source: 'gmail-sync',
    });
    const doc = await Person.findOne({ primaryEmail: 'sarah@acme.com' }).lean();
    expect(doc?.displayName).toBe('Sarah Connor');
  });

  it('does not overwrite a non-trivial displayName', async () => {
    await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Sarah Connor',
      occurredAt, source: 'gmail-sync',
    });
    await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Different Name',
      occurredAt, source: 'gmail-sync',
    });
    const doc = await Person.findOne({ primaryEmail: 'sarah@acme.com' }).lean();
    expect(doc?.displayName).toBe('Sarah Connor');
  });

  it('respects suppressReingest=true: link only, no mutation', async () => {
    const created = await Person.create({
      displayName: 'Sarah Connor',
      primaryEmail: 'sarah@acme.com',
      emails: ['sarah@acme.com'],
      source: 'concierge',
      suppressReingest: true,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const r = await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'NEW NAME',
      occurredAt, source: 'gmail-sync',
    });
    expect(r.personId.toHexString()).toBe(
      (created._id as { toHexString(): string }).toHexString(),
    );
    expect(r.tombstonedSuppressed).toBe(true);
    const after = await Person.findById(created._id).lean();
    expect(after?.displayName).toBe('Sarah Connor');
    expect(after?.deletedAt).not.toBeNull();
  });

  it('clears deletedAt on suppressReingest=false (manual undelete path)', async () => {
    const created = await Person.create({
      displayName: 'Sarah Connor',
      primaryEmail: 'sarah@acme.com',
      emails: ['sarah@acme.com'],
      source: 'concierge',
      suppressReingest: false,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const r = await upsertPerson({
      email: 'sarah@acme.com',
      displayName: 'Sarah Connor',
      occurredAt, source: 'gmail-sync',
    });
    expect(r.tombstonedSuppressed).toBe(false);
    const after = await Person.findById(created._id).lean();
    expect(after?.deletedAt).toBeNull();
  });
});
