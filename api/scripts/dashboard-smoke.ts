/**
 * End-to-end dashboard smoke: boots the API + (already-built) Next.js dashboard
 * against a Mongo testcontainer, seeds a small concierge dataset, then HTTP-GETs
 * every dashboard route and verifies they 200 with non-empty markup.
 *
 * Requires: `npm -w @kizuna/web run build` to have run first.
 *
 * Run from workspace root: tsx api/scripts/dashboard-smoke.ts
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { GenericContainer } from 'testcontainers';
import { loadConfig } from '../src/config.js';
import { connectDb } from '../src/db/connect.js';
import '../src/db/models/index.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/server.js';

const TEST_API_KEY = 'dashboard-smoke-key-1234567890abcdef';

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
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ${C_RED}✗${C_RESET} ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n${C_BOLD}▸ ${title}${C_RESET}`);
}

async function main(): Promise<void> {
  console.log(`${C_BOLD}Kizuna dashboard smoke${C_RESET}`);
  console.log(`${C_DIM}Starting Mongo + API + Next.js (web)...${C_RESET}`);

  const container = await new GenericContainer('mongo:7')
    .withExposedPorts(27017)
    .start();
  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/kizuna_dash`;

  const config = loadConfig({
    KIZUNA_API_KEY: TEST_API_KEY,
    MONGO_URI: uri,
    USER_EMAILS: 'me@example.com',
    LOG_LEVEL: 'silent',
  });
  const logger = createLogger(config.LOG_LEVEL);
  const db = await connectDb(config.MONGO_URI, logger);
  const app = createApp({ db, config, logger });

  const apiServer = app.listen(0);
  await once(apiServer, 'listening');
  const apiAddr = apiServer.address();
  if (!apiAddr || typeof apiAddr === 'string') throw new Error('api: no port');
  const apiBase = `http://127.0.0.1:${apiAddr.port}`;

  // Spawn `next start` for web/, pointed at our API and a free port.
  const webPort = String(40_000 + Math.floor(Math.random() * 5000));
  const web = spawn(
    'npx',
    ['--yes', 'next', 'start', '-p', webPort],
    {
      cwd: new URL('../../web', import.meta.url).pathname,
      env: {
        ...process.env,
        KIZUNA_API_URL: apiBase,
        KIZUNA_API_KEY: TEST_API_KEY,
        USER_EMAILS: 'me@example.com',
        // Suppress Next telemetry noise
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  web.stdout?.on('data', () => {});
  let webStderr = '';
  web.stderr?.on('data', (b) => {
    webStderr += String(b);
  });

  // Poll until the dashboard responds.
  const webBase = `http://127.0.0.1:${webPort}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    try {
      const r = await fetch(`${webBase}/`);
      if (r.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // not yet
    }
  }

  const cleanup = async (): Promise<void> => {
    web.kill('SIGTERM');
    await wait(200);
    apiServer.close();
    await db.close();
    await container.stop();
  };

  try {
    if (!ready) {
      console.log(
        `${C_RED}Web didn't come up. stderr tail:${C_RESET}\n${webStderr.slice(-1000)}`,
      );
      throw new Error('web boot timeout');
    }

    section('Seed data');
    const apiH = { authorization: `Bearer ${TEST_API_KEY}` };
    const orgRes = await fetch(`${apiBase}/v1/organizations`, {
      method: 'POST',
      headers: { ...apiH, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', domain: 'acme.com' }),
    });
    check('seed: org', orgRes.status === 201);
    const org = (await orgRes.json()) as { id: string };

    const sarahRes = await fetch(`${apiBase}/v1/people`, {
      method: 'POST',
      headers: { ...apiH, 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Sarah Connor',
        primaryEmail: 'sarah@acme.com',
        primaryOrgId: org.id,
        tags: ['ally'],
      }),
    });
    check('seed: person', sarahRes.status === 201);
    const sarah = (await sarahRes.json()) as { id: string };

    const meRes = await fetch(`${apiBase}/v1/people`, {
      method: 'POST',
      headers: { ...apiH, 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Me',
        primaryEmail: 'me@example.com',
      }),
    });
    check('seed: me', meRes.status === 201);
    const me = (await meRes.json()) as { id: string };

    const intRes = await fetch(`${apiBase}/v1/interactions`, {
      method: 'POST',
      headers: { ...apiH, 'content-type': 'application/json' },
      body: JSON.stringify({
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        channel: 'email',
        title: 'Re: Q1 review',
        body: 'thanks, deck attached',
        participants: [
          { personId: me.id, role: 'from' },
          { personId: sarah.id, role: 'to' },
        ],
        context: ['project:acme-redesign'],
      }),
    });
    check('seed: interaction', intRes.status === 201);

    const fuRes = await fetch(`${apiBase}/v1/followups`, {
      method: 'POST',
      headers: { ...apiH, 'content-type': 'application/json' },
      body: JSON.stringify({
        personId: sarah.id,
        direction: 'i_owe',
        reason: 'send the deck',
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    });
    check('seed: overdue followup', fuRes.status === 201);

    section('Dashboard routes render');
    const routes = [
      { path: '/', expects: ['Today', 'Overdue followups'] },
      { path: '/people', expects: ['People', 'Sarah Connor'] },
      { path: `/people/${sarah.id}`, expects: ['Sarah Connor', 'Re: Q1 review'] },
      { path: '/contexts', expects: ['Contexts', 'project:acme-redesign'] },
      { path: '/sync', expects: ['Sync', 'Connect Google', 'not granted'] },
      { path: '/errors', expects: ['Errors'] },
      { path: '/tombstones', expects: ['Tombstones'] },
    ];
    for (const r of routes) {
      const res = await fetch(`${webBase}${r.path}`);
      check(`GET ${r.path} → 200`, res.status === 200, `got ${res.status}`);
      const html = await res.text();
      for (const term of r.expects) {
        check(
          `${r.path} contains "${term}"`,
          html.includes(term),
          `not found in HTML`,
        );
      }
    }

    // Tombstone sarah, verify the row reflects it.
    const delRes = await fetch(`${apiBase}/v1/people/${sarah.id}`, {
      method: 'DELETE',
      headers: apiH,
    });
    check('tombstone sarah', delRes.status === 200);

    const tombHtml = await (await fetch(`${webBase}/tombstones`)).text();
    check(
      '/tombstones lists Sarah after delete',
      tombHtml.includes('Sarah Connor'),
    );

    const incTombHtml = await (
      await fetch(`${webBase}/people?includeTombstoned=true`)
    ).text();
    check(
      '/people?includeTombstoned shows tombstoned badge',
      incTombHtml.includes('tombstoned') && incTombHtml.includes('Sarah Connor'),
    );

    section('OAuth status surfaces on /sync');
    const { OAuthToken } = await import('../src/db/models/OAuthToken.js');
    await OAuthToken.create({
      provider: 'google',
      refreshToken: 'fake-encrypted-blob-not-real',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      grantedAt: new Date(),
      source: 'concierge',
    });
    const grantedSync = await (await fetch(`${webBase}/sync`)).text();
    check(
      '/sync flips to "granted" after OAuthToken upsert',
      grantedSync.includes('Re-authorize') && grantedSync.includes('gmail.readonly'),
    );
  } finally {
    await cleanup();
  }

  console.log(`\n${'─'.repeat(60)}`);
  const summary = `${passed} passed, ${failed} failed`;
  if (failed > 0) {
    console.log(`${C_RED}${C_BOLD}${summary}${C_RESET}`);
    for (const f of failures) console.log(`  ${C_RED}- ${f}${C_RESET}`);
    process.exit(1);
  }
  console.log(`${C_GREEN}${C_BOLD}${summary}${C_RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[dashboard-smoke] fatal:', err);
  process.exit(1);
});
