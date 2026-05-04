import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { OAuth2Client } from 'google-auth-library';
import { OAuthToken } from '../src/db/models/OAuthToken.js';
import { decrypt } from '../src/lib/encryption.js';
import { startHarness, type TestHarness } from './helpers/harness.js';

let h: TestHarness;
const auth = () => `Bearer ${h.apiKey}`;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.stop();
});

afterEach(async () => {
  await OAuthToken.deleteMany({});
  vi.restoreAllMocks();
});

describe('GET /oauth/google/start', () => {
  it('rejects without an api key (401)', async () => {
    const res = await request(h.app).get('/oauth/google/start');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects with the wrong api key (401)', async () => {
    const res = await request(h.app).get('/oauth/google/start?key=wrong');
    expect(res.status).toBe(401);
  });

  it('redirects to Google with the right params on bearer auth', async () => {
    const res = await request(h.app)
      .get('/oauth/google/start')
      .set('authorization', auth());
    expect(res.status).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2/);
    const url = new URL(loc);
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.kizuna.localhost/oauth/google/callback',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('also accepts ?key= for browser-initiated flows', async () => {
    const res = await request(h.app).get(
      `/oauth/google/start?key=${h.apiKey}`,
    );
    expect(res.status).toBe(302);
  });
});

describe('GET /oauth/google/callback', () => {
  async function getValidState(): Promise<string> {
    const r = await request(h.app)
      .get('/oauth/google/start')
      .set('authorization', auth());
    const loc = new URL(r.headers.location as string);
    return loc.searchParams.get('state')!;
  }

  it('rejects without code/state (400)', async () => {
    const res = await request(h.app).get('/oauth/google/callback');
    expect(res.status).toBe(400);
  });

  it('rejects an explicit Google error (400)', async () => {
    const res = await request(h.app).get(
      '/oauth/google/callback?error=access_denied',
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/access_denied/);
  });

  it('rejects an unsigned/forged state (401)', async () => {
    const res = await request(h.app).get(
      '/oauth/google/callback?code=abc&state=not-real.signed',
    );
    expect(res.status).toBe(401);
  });

  it('exchanges code, encrypts refresh, upserts oauth_tokens', async () => {
    const state = await getValidState();
    const spy = vi.spyOn(OAuth2Client.prototype, 'getToken') as unknown as {
      mockResolvedValue: (v: unknown) => unknown;
      mock: { calls: unknown[][] };
    };
    spy.mockResolvedValue({
      tokens: {
        access_token: 'ya29.fake-access',
        refresh_token: '1//refresh-fake',
        expiry_date: Date.now() + 3_500_000,
        scope:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
        token_type: 'Bearer',
      },
      res: null,
    });

    const res = await request(h.app).get(
      `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0]).toEqual(['auth-code']);

    const stored = await OAuthToken.findOne({ provider: 'google' }).lean();
    expect(stored).toBeTruthy();
    expect(stored!.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    // Refresh token is encrypted at rest.
    expect(stored!.refreshToken).not.toBe('1//refresh-fake');
    const decrypted = decrypt(stored!.refreshToken as string, h.encryptionKey);
    expect(decrypted).toBe('1//refresh-fake');
  });

  it('rejects when Google returns no refresh_token', async () => {
    const state = await getValidState();
    const spy = vi.spyOn(OAuth2Client.prototype, 'getToken') as unknown as {
      mockResolvedValue: (v: unknown) => unknown;
    };
    spy.mockResolvedValue({
      tokens: {
        access_token: 'ya29.fake',
        expiry_date: Date.now() + 3_500_000,
        token_type: 'Bearer',
      },
      res: null,
    });
    const res = await request(h.app).get(
      `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/refresh_token/);
  });
});

describe('GET /oauth/google/status', () => {
  it('rejects without auth', async () => {
    const res = await request(h.app).get('/oauth/google/status');
    expect(res.status).toBe(401);
  });

  it('reports granted=false when no token is on file', async () => {
    const res = await request(h.app)
      .get('/oauth/google/status')
      .set('authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ granted: false });
  });

  it('reports granted=true after a successful callback', async () => {
    // Seed a fake token directly.
    await OAuthToken.create({
      provider: 'google',
      refreshToken: 'encrypted-blob-doesnt-matter-here',
      scopes: ['gmail.readonly'],
      grantedAt: new Date('2026-04-01T00:00:00Z'),
      source: 'concierge',
    });
    const res = await request(h.app)
      .get('/oauth/google/status')
      .set('authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(true);
    expect(res.body.scopes).toEqual(['gmail.readonly']);
    expect(new Date(res.body.grantedAt).toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  });
});
