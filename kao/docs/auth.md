# Auth & threat model

Kao is single-user, single-machine like its siblings — **but it deliberately
does not inherit their "open at localhost, the OS user is the trust boundary"
posture for its sensitive surface.**

## Why Kao is the exception

The other services' resource routes are open at localhost because the worst a
local caller can do is read/write that service's own DB. Kao is different: it
holds the **single most sensitive credential in the workspace** — a Google
refresh token that, for the `kokoro` grant, can **send email as the user and
write their calendar**. Anyone who can reach the vend endpoint can act as the
user on Google. And per the workspace's VPS-deployment intent, Kagami is
headed off localhost; auth must not be relaxed on "single-user localhost"
grounds and then forgotten at exposure time.

So:

| Surface                                          | Posture                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `GET /healthz`, `GET /`                          | open@localhost — liveness + an operator page that holds no secret                           |
| `GET /oauth/:grant/start`, `GET /oauth/callback` | open@localhost, **defended by signed CSRF state** (browser navigation can't carry a bearer) |
| `GET/DELETE /grants/*` (incl. token vend)        | **always bearer-gated** — `Authorization: Bearer ${KAO_TOKEN}`                              |

## The bearer (`KAO_TOKEN`)

A ≥16-char shared secret consumers present. The check (`src/lib/auth.ts`)
SHA-256s both the presented and expected token, then `timingSafeEqual`s the
digests — equal-length, constant-time, no length oracle. Missing, malformed,
or wrong → `401`. Rotate by updating `KAO_TOKEN` here and in each consumer's
`.env`, then restarting.

## CSRF state (the OAuth flow's defense)

The adversary model for `/oauth/callback` is the real one even at localhost:
an external site could try to drive the operator's browser through a consent
that lands on Kao's callback. Ported from Kizuna's `oauth-state.ts` and
extended:

```
state = base64url(nonce(16) ‖ ":" ‖ tsSeconds ‖ ":" ‖ grant) "." base64url(HMAC_SHA256(secret, payload))
```

- HMAC secret: `randomBytes(32)` at module load — **process-local, not
  persisted**. Restarting the API invalidates in-flight consents (operator
  re-clicks Connect).
- TTL 10 min; timing-safe signature compare.
- **The grant name is inside the signed payload.** A callback can't be
  replayed against a different grant than the one `/oauth/:grant/start`
  initiated — tampering the grant breaks the HMAC.

## Refresh tokens at rest

AES-256-GCM, ported verbatim from Kizuna's `encryption.ts`. Envelope =
`base64(iv(12) ‖ tag(16) ‖ ciphertext)`, fresh random IV per write, auth tag
verified on decrypt. Key = `KAO_ENCRYPTION_KEY`, a base64 32-byte secret
(zod rejects anything that doesn't decode to exactly 32 bytes). Generate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotating the key makes existing rows undecryptable — the fix is
`DELETE /grants/:grant` (or drop the collection) and re-run the consent flow.
The key still lives in env; encryption defends DB-only compromise
(filesystem snapshots, dotfile backups), not a full host compromise.

## What this posture defends

- **Local non-operator tooling hitting the vend endpoint** → blocked by the
  bearer (the siblings' open posture would not defend this; Kao does).
- **External OAuth-callback collisions** → signed, grant-bound CSRF state.
- **Refresh-token leakage via DB/filesystem snapshots** → AES-256-GCM at rest.
- **Callback replay against another grant** → grant bound under the HMAC.

## What it does not defend (and the exposure rule)

- Full OS-user / host compromise — `KAO_ENCRYPTION_KEY` and `KAO_TOKEN` are
  in env; an attacker who is the OS user reads both.
- Kao does **not** yet enable CORS restrictions or per-consumer bearers
  (one shared `KAO_TOKEN`).

Before any non-localhost exposure: per-consumer credentials (a distinct
bearer per grant so a leaked Kokoro secret can't read the Kizuna grant),
explicit CORS denial, and moving `KAO_ENCRYPTION_KEY` to a real secret store
are the next steps. Do not assume localhost trust for this service — it is
the one component where that assumption is most costly.
