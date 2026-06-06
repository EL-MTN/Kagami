---
name: portless-debug
description: Diagnose why a `*.localhost` URL in the Kagami workspace is broken — 404 from Portless, connection refused, `SELF_SIGNED_CERT_IN_CHAIN`, Safari can't resolve, or "the dashboard won't load." Use whenever a developer-facing URL like `https://kioku.localhost`, `https://api.kansoku.localhost`, etc. fails to respond as expected, or when setting up the workspace on a fresh machine. Trigger phrases: "portless 404", "localhost not loading", "TLS error", "ECONNREFUSED on .localhost", "site can't be reached", "Portless setup", "dev server up but URL dead".
---

# portless-debug — fix broken `*.localhost` URLs in Kagami

Every Kagami service is fronted by [Portless](https://github.com/vercel-labs/portless), which gives each app a stable `https://<name>.localhost` URL via a port-443 HTTPS proxy. When that URL doesn't work, the cause is almost always one of five things. Walk this tree in order — don't guess.

## The five failure modes

| Symptom                                                       | Likely cause                            | Section |
| ------------------------------------------------------------- | --------------------------------------- | ------- |
| Portless's branded "404 - Not Found" HTML page                | Upstream app isn't listening            | (1)     |
| `ECONNREFUSED`, `Connection refused`, browser "can't connect" | Proxy daemon isn't running              | (2)     |
| Browser says cert invalid / not trusted                       | Local CA never trusted                  | (3)     |
| `SELF_SIGNED_CERT_IN_CHAIN` from a Node tool                  | Node ignores system keychain (expected) | (4)     |
| Safari only: "can't find the server"                          | `/etc/hosts` not synced                 | (5)     |

## (1) Portless 404 page → upstream isn't listening

If `curl -sk https://X.localhost` returns Portless's "404 - Not Found" HTML (long `<!DOCTYPE html>` with embedded fonts), the proxy is fine but no app is bound to that route. Check:

```bash
portless list   # lists every active route → port mapping
```

Expected (when everything is up): one entry per app from the workspace's `portless.json` files (`api.kansoku`, `kansoku`, `api.kioku`, `kioku`, `api.kizuna`, `kizuna`, `api.kao`, `kao`, `bot.kokoro`, `kokoro`, `kagami`). Missing routes mean that app's dev server isn't running. Start it:

```bash
# Start the missing app (pick the right one)
npm run kioku:dev:api          # https://api.kioku.localhost
npm run kioku:dev:dashboard    # https://kioku.localhost
npm run kokoro:dev:bot         # bot — no URL (Telegram long-poll)
npm run kokoro:dev:dashboard   # https://kokoro.localhost
npm run kizuna:dev:api         # https://api.kizuna.localhost
npm run kizuna:dev:dashboard   # https://kizuna.localhost
npm run kansoku:dev:api        # https://api.kansoku.localhost
npm run kansoku:dev:dashboard  # https://kansoku.localhost
npm run kao:dev:api            # https://api.kao.localhost
npm run kao:dev:dashboard      # https://kao.localhost
npm run cockpit:dev:dashboard  # https://kagami.localhost

# Or boot everything at once
./dev-all.sh
```

If `portless list` shows the route but the app still 404s, the dev server probably crashed mid-boot. Check its logs (in the Turbo TUI pane or the foreground terminal). If you see orphaned routes from a crashed prior session, `portless prune` reclaims them.

## (2) ECONNREFUSED → proxy daemon isn't running

Portless runs a persistent daemon on port 443 (`portless proxy start --foreground --port 443 --https`). It survives across sessions and is normally already up.

```bash
ps aux | grep "portless proxy" | grep -v grep   # is the daemon alive?
portless proxy start                             # start it (idempotent)
portless proxy stop && portless proxy start      # restart if behaving weirdly
```

Note: the proxy binds port 443, which requires root. The first install asks for sudo once; thereafter it survives reboots. If it won't start, something else owns 443 (`sudo lsof -i :443`).

## (3) Browser cert untrusted

Portless installs a local CA into the system keychain on first run. If the browser shows a cert error, the CA was removed or never installed:

```bash
portless trust         # idempotent — re-adds CA to system trust store
```

Restart the browser after running this. Chrome and Safari both read from the macOS keychain.

## (4) `SELF_SIGNED_CERT_IN_CHAIN` from a Node script — expected, work around it

Node uses its own bundled CA list, NOT the macOS keychain. So `fetch("https://api.kioku.localhost")` from a tsx script will fail with `SELF_SIGNED_CERT_IN_CHAIN` _even when the cert is trusted by the browser_. This is not a Portless bug — it's how Node works.

Three workarounds, in order of preference:

1. **Per-request TLS bypass via `node:https`** — preferred. Disable verification only on the request, scoped to `.localhost` hosts. Pattern (see `kansoku/apps/api/scripts/kansoku-debug.ts` for a complete example):
   ```ts
   import https from "node:https";
   https.request({ hostname, path, rejectUnauthorized: false }, ...);
   ```
2. **Point at `NODE_EXTRA_CA_CERTS`** — add Portless's CA file. More principled but every script needs the env var.
3. **`NODE_TLS_REJECT_UNAUTHORIZED=0`** — process-global; Node prints a loud warning on every invocation; only OK as a one-off in `curl`-style debugging. Don't ship this.

## (5) Safari can't resolve `.localhost`

Chrome and Firefox resolve `*.localhost` to 127.0.0.1 automatically. Safari doesn't — it needs entries in `/etc/hosts`:

```bash
portless hosts sync    # adds every active route to /etc/hosts (needs sudo)
portless hosts clean   # undo
```

## Nuclear options

When the state has drifted past easy fixes:

```bash
portless prune    # kill orphaned dev-server processes from crashed sessions
portless clean    # remove ALL portless state, trust entries, hosts entries
                  # then start fresh with `portless trust` + `./dev-all.sh`
```

## Quick triage one-liner

```bash
# Is the proxy up, are the routes registered, what curls back?
ps aux | grep -v grep | grep -q "portless proxy" && echo "proxy: UP" || echo "proxy: DOWN"
portless list
curl -sk -o /dev/null -w "%{http_code}\n" https://api.kioku.localhost/health
```

A `200` from health = end-to-end working. A `404` = upstream missing. `Connection refused` = proxy missing.

## What NOT to do

- Don't kill the `root`-owned `portless proxy start` process — it's the daemon. Killing it breaks every `.localhost` URL in the workspace.
- Don't add `NODE_TLS_REJECT_UNAUTHORIZED=0` to any committed script or env file.
- Don't bind apps to numeric ports as a workaround. The whole point of Portless is that PORT is ephemeral; production code referencing `localhost:7777` etc. defeats it.
