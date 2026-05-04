import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { type Config, loadConfig } from '../src/config.js';
import { Interaction } from '../src/db/models/Interaction.js';
import { Person } from '../src/db/models/Person.js';
import { SyncState } from '../src/db/models/SyncState.js';
import { runGmailSync } from '../src/ingest/gmail.js';
import { startHarness, type TestHarness } from './helpers/harness.js';
import { FakeGmailClient, buildPlainMessage } from './helpers/fake-gmail.js';

let h: TestHarness;
const silentLogger = pino({ level: 'silent' });

function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    KIZUNA_API_KEY: h.apiKey,
    MONGO_URI: h.uri,
    USER_EMAILS: 'me@example.com',
    KIZUNA_OAUTH_ENCRYPTION_KEY: h.encryptionKey,
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI:
      'https://api.kizuna.localhost/oauth/google/callback',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([
    Person.deleteMany({}),
    Interaction.deleteMany({}),
    SyncState.deleteMany({}),
  ]);
});

afterEach(() => {
  // each test owns its FakeGmailClient
});

describe('runGmailSync — skip-self on group emails', () => {
  it('drops user from to/cc when ≥ 2 other recipients', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'group-1',
        from: 'Sarah <sarah@acme.com>',
        to: 'me@example.com, bob@bar.com, carol@acme.com',
        subject: 'team sync',
        body: 'all',
      }),
    );
    await runGmailSync({
      config: makeConfig({ USER_EMAILS: 'me@example.com' }),
      client,
      logger: silentLogger,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ personId: { toHexString(): string }; role: string }>;
    }>;
    expect(ints.length).toBe(1);

    const people = (await Person.find().lean()) as unknown as Array<{
      _id: { toHexString(): string };
      primaryEmail: string;
    }>;
    // Self isn't linked → never upserted as a Person.
    expect(people.find((p) => p.primaryEmail === 'me@example.com')).toBeUndefined();
    expect(people.map((p) => p.primaryEmail).sort()).toEqual([
      'bob@bar.com',
      'carol@acme.com',
      'sarah@acme.com',
    ]);
    // Sender (sarah) still 'from'; bob + carol as 'to'. Self is dropped.
    expect(ints[0]!.participants.length).toBe(3);
  });

  it('keeps user as a participant in 1:1 emails', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: '1to1-1',
        from: 'Sarah <sarah@acme.com>',
        to: 'me@example.com',
        subject: 'just us',
        body: 'hi',
      }),
    );
    await runGmailSync({
      config: makeConfig({ USER_EMAILS: 'me@example.com' }),
      client,
      logger: silentLogger,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ role: string }>;
    }>;
    expect(ints[0]!.participants.length).toBe(2);
    const roles = ints[0]!.participants.map((p) => p.role).sort();
    expect(roles).toEqual(['from', 'to']);
  });

  it('keeps self in `from` role even on outbound group emails', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'outbound-group-1',
        from: 'me@example.com',
        to: 'sarah@acme.com, bob@bar.com, carol@acme.com',
        subject: 'I sent this',
        body: 'hi all',
      }),
    );
    await runGmailSync({
      config: makeConfig({ USER_EMAILS: 'me@example.com' }),
      client,
      logger: silentLogger,
    });
    const ints = (await Interaction.find().lean()) as unknown as Array<{
      participants: Array<{ personId: { toHexString(): string }; role: string }>;
    }>;
    const people = (await Person.find().lean()) as unknown as Array<{
      _id: { toHexString(): string };
      primaryEmail: string;
    }>;
    const meId = people.find((p) => p.primaryEmail === 'me@example.com')!._id.toHexString();
    const fromParticipants = ints[0]!.participants.filter((p) => p.role === 'from');
    expect(fromParticipants.map((p) => p.personId.toHexString())).toContain(meId);
  });
});

describe('runGmailSync — bootstrap', () => {
  it('inserts each message as an interaction with sourceRef', async () => {
    const client = new FakeGmailClient();
    client.profileHistoryId = '5000';
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'Sarah Connor <sarah@acme.com>',
        to: 'me@example.com',
        subject: 'Re: Q1 review',
        body: 'thanks, deck attached',
        date: 'Thu, 15 Jan 2026 09:30:00 -0500',
      }),
    );
    client.add(
      buildPlainMessage({
        id: 'msg-2',
        from: 'Bob <bob@bar.com>',
        to: 'me@example.com',
        subject: 'lunch?',
        body: 'thursday?',
      }),
    );

    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    expect(r.status).toBe('ok');
    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.historyIdAfter).toBe('5000');

    const ints = (await Interaction.find().sort({ occurredAt: 1 }).lean()) as unknown as Array<{
      source: string;
      channel: string;
      sourceRef: { provider: string; id: string };
    }>;
    expect(ints.length).toBe(2);
    expect(ints.every((i) => i.source === 'gmail-sync')).toBe(true);
    expect(ints.every((i) => i.channel === 'email')).toBe(true);
    const refs = ints.map((i) => i.sourceRef);
    expect(refs.map((r) => r.id).sort()).toEqual(['msg-1', 'msg-2']);

    const state = await SyncState.findOne({ provider: 'gmail' }).lean();
    expect(state?.historyId).toBe('5000');
    expect(state?.lastError).toBeNull();
    expect(state?.pausedAt).toBeNull();
  });

  it('upserts sender + recipients as people with source=gmail-sync', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'Sarah Connor <sarah@acme.com>',
        to: 'me@example.com',
        cc: 'Bob <bob@bar.com>',
        subject: 'hi',
        body: 'x',
      }),
    );
    await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    const people = (await Person.find().sort({ primaryEmail: 1 }).lean()) as unknown as Array<{
      primaryEmail: string | null;
      source: string;
    }>;
    expect(people.length).toBe(3);
    expect(people.map((p) => p.primaryEmail)).toEqual([
      'bob@bar.com',
      'me@example.com',
      'sarah@acme.com',
    ]);
    expect(people.every((p) => p.source === 'gmail-sync')).toBe(true);
  });

  it('updates lastInteractionAt on each participant via $max', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'Sarah <sarah@acme.com>',
        to: 'me@example.com',
        subject: 'hi',
        body: 'x',
        date: 'Thu, 15 Jan 2026 09:30:00 -0500',
      }),
    );
    await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    const sarah = (await Person.findOne({ primaryEmail: 'sarah@acme.com' }).lean()) as {
      lastInteractionAt: Date | null;
    } | null;
    expect(sarah?.lastInteractionAt?.toISOString()).toBe(
      '2026-01-15T14:30:00.000Z',
    );
  });
});

describe('runGmailSync — idempotency', () => {
  it('replays cleanly: second run inserts 0 (sourceRef unique)', async () => {
    const client = new FakeGmailClient();
    client.profileHistoryId = '5000';
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'a@b.com',
        to: 'me@example.com',
        subject: 'hi',
        body: 'x',
      }),
    );
    const config = makeConfig();
    const first = await runGmailSync({ config, client, logger: silentLogger });
    expect(first.inserted).toBe(1);

    // Reset state to force a re-bootstrap (same path Gmail would replay).
    await SyncState.updateOne(
      { provider: 'gmail' },
      { $set: { historyId: null } },
    );
    const second = await runGmailSync({ config, client, logger: silentLogger });
    expect(second.inserted).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(await Interaction.countDocuments()).toBe(1);
  });
});

describe('runGmailSync — newsletter filter', () => {
  it('skips messages with List-Unsubscribe header', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'newsletter-1',
        from: 'newsletter@beehiiv.com',
        to: 'me@example.com',
        subject: 'Weekly digest',
        body: '...',
        listUnsubscribe: '<mailto:unsub@beehiiv.com>',
      }),
    );
    client.add(
      buildPlainMessage({
        id: 'real-1',
        from: 'sarah@acme.com',
        to: 'me@example.com',
        subject: 'real one',
        body: '...',
      }),
    );
    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    expect(r.skippedNewsletter).toBe(1);
    expect(r.inserted).toBe(1);
    const ints = await Interaction.find().lean();
    expect(ints.length).toBe(1);
    expect((ints[0]!.sourceRef as { id: string }).id).toBe('real-1');
  });

  it('skips senders matching NEWSLETTER_DOMAIN_BLOCKLIST', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'spam-1',
        from: 'promo@spam.com',
        to: 'me@example.com',
        subject: 'BUY NOW',
        body: '...',
      }),
    );
    client.add(
      buildPlainMessage({
        id: 'real-1',
        from: 'sarah@acme.com',
        to: 'me@example.com',
        subject: 'real',
        body: '...',
      }),
    );
    const r = await runGmailSync({
      config: makeConfig({ NEWSLETTER_DOMAIN_BLOCKLIST: 'spam.com' }),
      client,
      logger: silentLogger,
    });
    expect(r.skippedNewsletter).toBe(1);
    expect(r.inserted).toBe(1);
    const ints = await Interaction.find().lean();
    expect((ints[0]!.sourceRef as { id: string }).id).toBe('real-1');
  });
});

describe('runGmailSync — suppressReingest', () => {
  it('links interaction to tombstoned person without mutating it', async () => {
    const tomb = await Person.create({
      displayName: 'Sarah Connor',
      primaryEmail: 'sarah@acme.com',
      emails: ['sarah@acme.com'],
      source: 'concierge',
      suppressReingest: true,
      deletedAt: new Date('2026-01-01T00:00:00Z'),
      notes: 'do not contact',
    });
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'Sarah Connor <sarah@acme.com>',
        to: 'me@example.com',
        subject: 'hi',
        body: 'x',
      }),
    );
    await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });

    const after = await Person.findById(tomb._id).lean();
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.notes).toBe('do not contact');

    const ints = await Interaction.find().lean();
    expect(ints.length).toBe(1);
    const participants = ints[0]!.participants as unknown as Array<{
      personId: { toHexString(): string };
      role: string;
    }>;
    const hasTombLink = participants.some(
      (p) =>
        p.personId.toHexString() ===
        (tomb._id as { toHexString(): string }).toHexString(),
    );
    expect(hasTombLink).toBe(true);
  });
});

describe('runGmailSync — incremental', () => {
  it('processes only history.messagesAdded ids', async () => {
    const client = new FakeGmailClient();
    // Two messages exist; only msg-2 was added since the cursor.
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'a@b.com',
        to: 'me@example.com',
        subject: 'old',
        body: 'x',
      }),
    );
    client.add(
      buildPlainMessage({
        id: 'msg-2',
        from: 'c@d.com',
        to: 'me@example.com',
        subject: 'new',
        body: 'y',
      }),
    );
    client.profileHistoryId = '5050';
    client.addAddedHistory('msg-2');

    // Pre-seed sync state so we go incremental.
    await SyncState.create({
      provider: 'gmail',
      historyId: '5000',
      source: 'gmail-sync',
    });

    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    expect(r.inserted).toBe(1);
    const ints = await Interaction.find().lean();
    expect(ints.length).toBe(1);
    expect((ints[0]!.sourceRef as { id: string }).id).toBe('msg-2');
    const state = await SyncState.findOne({ provider: 'gmail' }).lean();
    expect(state?.historyId).toBe('5050');
  });
});

describe('runGmailSync — invalid_grant', () => {
  it('pauses the worker on a 401 from Gmail', async () => {
    const client = new FakeGmailClient();
    client.add(
      buildPlainMessage({
        id: 'msg-1',
        from: 'a@b.com',
        to: 'me@example.com',
        subject: 'x',
        body: 'x',
      }),
    );
    client.fail401AtMessageId = 'msg-1';

    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    expect(r.status).toBe('paused');
    expect(r.message).toMatch(/invalid_grant|re-grant/);
    const state = await SyncState.findOne({ provider: 'gmail' }).lean();
    expect(state?.pausedAt).not.toBeNull();
    expect(state?.lastError).toMatch(/invalid_grant/);
  });

  it('subsequent runs without force are skipped', async () => {
    await SyncState.create({
      provider: 'gmail',
      historyId: '1000',
      pausedAt: new Date(),
      lastError: 'invalid_grant',
      source: 'gmail-sync',
    });
    const client = new FakeGmailClient();
    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
    });
    expect(r.status).toBe('paused');
    expect(r.fetched).toBe(0);
  });

  it('force=true clears the pause from the caller side and reruns', async () => {
    await SyncState.create({
      provider: 'gmail',
      historyId: '1000',
      pausedAt: new Date(),
      lastError: 'invalid_grant',
      source: 'gmail-sync',
    });
    const client = new FakeGmailClient();
    const r = await runGmailSync({
      config: makeConfig(),
      client,
      logger: silentLogger,
      force: true,
    });
    expect(r.status).toBe('ok');
  });
});

describe('GET /v1/sync/gmail/state', () => {
  it('returns a default state when no doc exists', async () => {
    const res = await request(h.app)
      .get('/v1/sync/gmail/state')
      .set('authorization', `Bearer ${h.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: 'gmail',
      historyId: null,
      lastRunAt: null,
      errorCount: 0,
      pausedAt: null,
    });
  });

  it('returns the live state after a run', async () => {
    await SyncState.create({
      provider: 'gmail',
      historyId: '7777',
      lastRunAt: new Date('2026-04-01T00:00:00Z'),
      errorCount: 2,
      lastError: 'transient',
      source: 'gmail-sync',
    });
    const res = await request(h.app)
      .get('/v1/sync/gmail/state')
      .set('authorization', `Bearer ${h.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.historyId).toBe('7777');
    expect(res.body.errorCount).toBe(2);
    expect(res.body.lastError).toBe('transient');
  });
});
