/**
 * Manifest-driven smoke test for Kizuna's REST API.
 *
 * Boots the API on a real ephemeral port against a Mongo testcontainer,
 * fetches /v1/_manifest, and exercises every endpoint via the manifest —
 * the same pattern Mashiro will use to consume the API.
 *
 * Run: npm run smoke
 */

import { GenericContainer } from 'testcontainers';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db/connect.js';
import '../src/db/models/index.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/server.js';

const TEST_API_KEY = 'smoke-test-api-key-1234567890abcdef';

const C_RESET = '\x1b[0m';
const C_GREEN = '\x1b[32m';
const C_RED = '\x1b[31m';
const C_DIM = '\x1b[2m';
const C_BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ${C_GREEN}✓${C_RESET} ${label}`);
  } else {
    failed++;
    const full = detail ? `${label} ${C_DIM}— ${detail}${C_RESET}` : label;
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ${C_RED}✗${C_RESET} ${full}`);
  }
}

function section(title: string): void {
  console.log(`\n${C_BOLD}▸ ${title}${C_RESET}`);
}

type ManifestEndpoint = {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: unknown;
};

type CallOpts = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  auth?: boolean;
};

async function main(): Promise<void> {
  console.log(`${C_BOLD}Kizuna smoke test${C_RESET}`);
  console.log(`${C_DIM}Starting Mongo testcontainer + API server...${C_RESET}`);

  const container = await new GenericContainer('mongo:7')
    .withExposedPorts(27017)
    .start();
  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/kizuna_smoke`;

  const config = loadConfig({
    KIZUNA_API_KEY: TEST_API_KEY,
    MONGO_URI: uri,
    USER_EMAILS: 'me@example.com',
    LOG_LEVEL: 'silent',
  });
  const logger = createLogger(config.LOG_LEVEL);
  const db = await connectDb(config.MONGO_URI, logger);
  const app = createApp({ db, config, logger });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  const base = `http://127.0.0.1:${address.port}`;

  const cleanup = async (): Promise<void> => {
    server.close();
    await db.close();
    await container.stop();
  };

  try {
    section('Manifest discovery');
    const mfRes = await fetch(`${base}/v1/_manifest`, {
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    check('GET /v1/_manifest → 200', mfRes.status === 200, `got ${mfRes.status}`);
    const manifest = (await mfRes.json()) as {
      version: string;
      endpoints: ManifestEndpoint[];
    };
    check('manifest.version = v1', manifest.version === 'v1');
    check(
      'manifest has ≥ 18 endpoints',
      manifest.endpoints.length >= 18,
      `got ${manifest.endpoints.length}`,
    );

    const byName = new Map<string, ManifestEndpoint>();
    for (const e of manifest.endpoints) byName.set(e.name, e);

    const expectedNames = [
      'find_people',
      'get_person',
      'add_person',
      'update_person',
      'tombstone_person',
      'get_interactions_for',
      'find_organizations',
      'get_organization',
      'add_organization',
      'update_organization',
      'tombstone_organization',
      'list_interactions',
      'log_interaction',
      'tombstone_interaction',
      'list_followups',
      'create_followup',
      'update_followup',
      'tombstone_followup',
    ];
    for (const name of expectedNames) {
      check(`manifest contains ${name}`, byName.has(name));
    }

    async function call<T = unknown>(
      name: string,
      opts: CallOpts = {},
    ): Promise<{ status: number; body: T }> {
      const ep = byName.get(name);
      if (!ep) throw new Error(`unknown endpoint: ${name}`);
      let path = ep.path;
      for (const [k, v] of Object.entries(opts.params ?? {})) {
        path = path.replace(`:${k}`, v);
      }
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
        else qs.set(k, String(v));
      }
      const url = `${base}${path}${qs.size ? `?${qs.toString()}` : ''}`;
      const headers: Record<string, string> = {};
      if (opts.auth !== false) {
        headers.authorization = `Bearer ${TEST_API_KEY}`;
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const resp = await fetch(url, {
        method: ep.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await resp.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      return { status: resp.status, body: body as T };
    }

    type Org = { id: string; name: string; domain: string | null };
    type Person = {
      id: string;
      primaryEmail: string | null;
      handles: Record<string, string>;
      lastInteractionAt: string | null;
      suppressReingest: boolean;
      deletedAt: string | null;
    };
    type Interaction = {
      id: string;
      title: string;
      sourceRef: unknown;
      source: string;
      deletedAt: string | null;
    };
    type Followup = { id: string; status: string; direction: string };
    type ListResp<T> = { items: T[]; nextCursor?: string };

    section('Realistic concierge flow');

    const org = await call<Org>('add_organization', {
      body: { name: 'Acme', domain: 'Acme.com' },
    });
    check('add_organization → 201', org.status === 201, `got ${org.status}`);
    check('domain lowercased on insert', org.body.domain === 'acme.com');

    const dup = await call<{ error: { code: string } }>('add_organization', {
      body: { name: 'Acme', domain: 'acme.com' },
    });
    check(
      'duplicate domain → 409 conflict',
      dup.status === 409 && dup.body.error?.code === 'conflict',
      `got ${dup.status}/${dup.body.error?.code}`,
    );

    const sarah = await call<Person>('add_person', {
      body: {
        displayName: 'Sarah Connor',
        primaryEmail: 'Sarah@Acme.com',
        primaryOrgId: org.body.id,
        tags: ['ally', 'mentor'],
        handles: { twitter: '@sarahc', github: 'sarah' },
      },
    });
    check('add_person → 201', sarah.status === 201);
    check('email lowercased', sarah.body.primaryEmail === 'sarah@acme.com');
    check('handles roundtrip', sarah.body.handles?.twitter === '@sarahc');

    const t1 = '2026-01-15T14:30:00.000Z';
    const interaction = await call<Interaction>('log_interaction', {
      body: {
        occurredAt: t1,
        channel: 'email',
        title: 'Re: Q1 review',
        body: 'thanks, deck attached',
        participants: [{ personId: sarah.body.id, role: 'from' }],
        context: ['project:acme-redesign'],
      },
    });
    check('log_interaction → 201', interaction.status === 201);
    check('source=concierge auto-set', interaction.body.source === 'concierge');
    check('sourceRef null on concierge writes', interaction.body.sourceRef === null);

    const sarahReread = await call<Person>('get_person', {
      params: { id: sarah.body.id },
    });
    check(
      'lastInteractionAt updated to interaction occurredAt',
      new Date(sarahReread.body.lastInteractionAt!).toISOString() ===
        new Date(t1).toISOString(),
      `got ${sarahReread.body.lastInteractionAt}`,
    );

    const earlier = await call<Interaction>('log_interaction', {
      body: {
        occurredAt: '2025-12-01T00:00:00.000Z',
        channel: 'email',
        title: 'older thread',
        participants: [{ personId: sarah.body.id, role: 'to' }],
      },
    });
    check('older interaction → 201', earlier.status === 201);
    const sarahAfterOld = await call<Person>('get_person', {
      params: { id: sarah.body.id },
    });
    check(
      'lastInteractionAt unchanged by older interaction ($max)',
      new Date(sarahAfterOld.body.lastInteractionAt!).toISOString() ===
        new Date(t1).toISOString(),
    );

    const followup = await call<Followup>('create_followup', {
      body: {
        personId: sarah.body.id,
        direction: 'i_owe',
        reason: 'send the deck',
        dueAt: '2026-01-20T00:00:00.000Z',
        sourceInteractionId: interaction.body.id,
      },
    });
    check('create_followup → 201', followup.status === 201);
    check('default status=open', followup.body.status === 'open');
    check('direction=i_owe', followup.body.direction === 'i_owe');

    section('Filter DSL');

    const withFollowup = await call<ListResp<Person>>('find_people', {
      query: { hasOpenFollowup: true },
    });
    check(
      'hasOpenFollowup=true returns sarah',
      withFollowup.body.items.some((p) => p.id === sarah.body.id),
    );

    const byOrg = await call<ListResp<Interaction>>('list_interactions', {
      query: { orgId: org.body.id },
    });
    check(
      'list_interactions?orgId joins via primaryOrgId',
      byOrg.body.items.length === 2,
      `got ${byOrg.body.items.length}`,
    );

    const byContext = await call<ListResp<Interaction>>('list_interactions', {
      query: { context: 'project:acme-redesign' },
    });
    check(
      'context filter matches one interaction',
      byContext.body.items.length === 1 &&
        byContext.body.items[0]?.title === 'Re: Q1 review',
    );

    const byChannel = await call<ListResp<Interaction>>('list_interactions', {
      query: { channel: 'email' },
    });
    check('channel filter', byChannel.body.items.length === 2);

    const dateRange = await call<ListResp<Interaction>>('list_interactions', {
      query: {
        occurredAfter: '2026-01-01T00:00:00.000Z',
        occurredBefore: '2026-02-01T00:00:00.000Z',
      },
    });
    check('date range filter', dateRange.body.items.length === 1);

    const byTag = await call<ListResp<Person>>('find_people', {
      query: { tag: ['ally', 'mentor'] },
    });
    check(
      'find_people?tag=ally&tag=mentor (AND)',
      byTag.body.items.some((p) => p.id === sarah.body.id),
    );

    const personScoped = await fetch(
      `${base}/v1/people/${sarah.body.id}/interactions`,
      { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
    );
    const personScopedBody = (await personScoped.json()) as ListResp<Interaction>;
    check(
      'GET /v1/people/:id/interactions returns sarah\'s interactions only',
      personScoped.status === 200 && personScopedBody.items.length === 2,
    );

    section('State transitions');

    const done = await call<Followup>('update_followup', {
      params: { id: followup.body.id },
      body: { status: 'done' },
    });
    check(
      'update_followup status=done → 200',
      done.status === 200 && done.body.status === 'done',
    );

    const openOnly = await call<ListResp<Followup>>('list_followups');
    check(
      'list_followups defaults to status=open (excludes done)',
      openOnly.body.items.length === 0,
    );

    const doneList = await call<ListResp<Followup>>('list_followups', {
      query: { status: 'done' },
    });
    check('list_followups?status=done finds it', doneList.body.items.length === 1);

    section('Tombstone semantics');

    const tomb = await call<Person>('tombstone_person', {
      params: { id: sarah.body.id },
    });
    check('tombstone_person → 200', tomb.status === 200);
    check('suppressReingest set true', tomb.body.suppressReingest === true);
    check('deletedAt set', tomb.body.deletedAt !== null);

    const after = await call('get_person', { params: { id: sarah.body.id } });
    check('tombstoned person 404 by default', after.status === 404);

    const withTombs = await call<ListResp<Person>>('find_people', {
      query: { includeTombstoned: true },
    });
    check(
      'includeTombstoned=true returns sarah',
      withTombs.body.items.some((p) => p.id === sarah.body.id),
    );

    const tombInt = await call<Interaction>('tombstone_interaction', {
      params: { id: interaction.body.id },
    });
    check('tombstone_interaction → 200', tombInt.status === 200);
    check('interaction.deletedAt set', tombInt.body.deletedAt !== null);

    section('Validation + auth boundaries');

    const noAuth = await call('find_people', { auth: false });
    check('no bearer → 401', noAuth.status === 401);

    const wrongAuth = await fetch(`${base}/v1/people`, {
      headers: { authorization: 'Bearer wrong-key' },
    });
    check('wrong bearer → 401', wrongAuth.status === 401);

    const badField = await call('add_person', {
      body: { displayName: 'X', bogus: 'no' },
    });
    check('unknown field → 400', badField.status === 400);

    const badEmail = await call('add_person', {
      body: { displayName: 'X', primaryEmail: 'not-an-email' },
    });
    check('bad email → 400', badEmail.status === 400);

    const noBody = await call('add_person', { body: {} });
    check('missing displayName → 400', noBody.status === 400);

    const badId = await call('get_person', { params: { id: 'not-an-objectid' } });
    check('bad ObjectId param → 400', badId.status === 400);

    const badCursor = await call('find_people', {
      query: { cursor: 'not-a-real-cursor!!!' },
    });
    check('bad cursor → 400', badCursor.status === 400);

    const badRoute = await fetch(`${base}/v1/nope`, {
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    check('unknown /v1 path → 404', badRoute.status === 404);

    section('Pagination');

    // Create 3 throwaway people, verify cursor pagination on a 2-deep walk.
    for (let i = 0; i < 3; i++) {
      await call('add_person', { body: { displayName: `Throwaway ${i}` } });
    }
    const page1 = await call<ListResp<Person>>('find_people', {
      query: { limit: 2 },
    });
    check('page 1 has 2 items', page1.body.items.length === 2);
    check('page 1 has nextCursor', typeof page1.body.nextCursor === 'string');

    const page2 = await call<ListResp<Person>>('find_people', {
      query: { limit: 2, cursor: page1.body.nextCursor },
    });
    check('page 2 has remaining items', page2.body.items.length >= 1);
    const page1Ids = new Set(page1.body.items.map((p) => p.id));
    const page2Ids = new Set(page2.body.items.map((p) => p.id));
    const overlap = [...page1Ids].some((id) => page2Ids.has(id));
    check('pages do not overlap', !overlap);
  } finally {
    await cleanup();
  }

  console.log(`\n${'─'.repeat(60)}`);
  const summary = `${passed} passed, ${failed} failed`;
  if (failed > 0) {
    console.log(`${C_RED}${C_BOLD}${summary}${C_RESET}`);
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${C_RED}- ${f}${C_RESET}`);
    process.exit(1);
  }
  console.log(`${C_GREEN}${C_BOLD}${summary}${C_RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[smoke] fatal:', err);
  process.exit(1);
});
