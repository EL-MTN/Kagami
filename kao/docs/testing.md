# Testing

vitest + supertest + `mongodb-memory-server` (a real in-memory Mongo, no
Docker) — the same harness shape as Kioku/Kizuna. Config:
`kao/vitest.config.ts` (pool `forks`, `fileParallelism: false`,
`isolate: false`; a single shared in-memory Mongo via `global-setup.ts`;
`setup.ts` defaults the logger to `silent`).

Run from the Kagami root:

```bash
npx turbo run test --filter=@kao/api
cd kao && npx vitest            # or --watch
cd kao && LOG_LEVEL=debug npx vitest   # when triaging — env binding has to land on the vitest invocation, not the cd
```

## What's covered (45 tests, 5 files)

| File                     | Covers                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encryption.test.ts`     | AES-256-GCM round-trip, random-IV uniqueness, wrong-key / tampered-envelope / undersized-envelope rejection, 32-byte key enforcement                                                                                                                                                                                                                                                                    |
| `oauth-state.test.ts`    | sign/verify round-trip, **grant recovery + binding**, tampered-signature and tampered-grant rejection, TTL expiry vs in-window, malformed input                                                                                                                                                                                                                                                         |
| `grant-registry.test.ts` | exactly `{kizuna, kokoro}`; `isGrantName` rejects unknowns / `__proto__` / empty; **kizuna stays read-only (no send/calendar-write)**; kokoro has the write scopes; `scopesFor` returns a non-aliasing copy                                                                                                                                                                                             |
| `config.test.ts`         | valid env + defaults; missing Google id, bad key length, short bearer, non-mongodb URI all rejected; `callbackUrl` trailing-slash strip; **`KAO_DASHBOARD_URL` default + override + non-URL rejection + bare-trailing-slash acceptance**; symmetric `httpOrigin` refine on **`KAO_DASHBOARD_URL` and `KAO_PUBLIC_URL`** — rejects `javascript:` schemes and URLs carrying any path / query / fragment   |
| `routes.test.ts`         | supertest over the real app on in-memory Mongo: `/health` + `/` + `/oauth/:grant/start` (302, registry scopes, **no `gmail.send` for kizuna**) open; unknown grant 404; callback missing/bad-state 400/401; **`/grants` 401 without/with-wrong bearer, 200 with bearer**; unknown grant 404; `/grants/:grant/token` → 409 `no_grant` + 409 `decrypt_failed` on a tampered envelope; `DELETE` idempotent |

## Deliberate non-coverage: the Google refresh path

There is **no test that exercises a successful token refresh / vend**, and no
mocking of `google-auth-library`. Reaching `refreshAccessToken` requires a
real Google refresh token; an LLM-style stubbed success would only assert the
mock. This follows the workspace convention (see Kioku's
`relevance.test.ts`): test the **deterministic short-circuits** — the
`no_grant` 409 fires _before_ any Google call, the bearer gate fires before
the handler, the registry/scope/crypto/state logic is pure. The
refresh/`invalid_grant`/`502` branches are validated by reading, not a fake.

When a consumer is migrated, end-to-end vend correctness is proven by that
consumer's integration against a live Kao with a real grant — that is the
real arbiter, the same stance taken elsewhere in the workspace.

## Adding tests

When a route's behavior changes, fix the API to match the test (tests are the
contract), not the other way around. New deterministic logic (a new grant, a
new error mapping, a config rule) should get a pure unit test here; new
Google-touching behavior should be documented as deferred-to-integration
rather than mock-asserted.
