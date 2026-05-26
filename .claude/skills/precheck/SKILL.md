---
name: precheck
description: Fast pre-push static verification for the Kagami workspace. Determines which projects (kioku, kokoro, kizuna, kansoku, kao, shared) have changes in the working tree and runs targeted typecheck + lint via Turborepo filters, skipping unaffected workspaces. Use before committing or pushing to catch regressions quickly without the wall-clock cost of running `npm run typecheck && npm run test` across all five projects. Trigger phrases include "precheck", "fast verify", "is this ready to commit", "is this ready to push", "quick check before pushing".
---

# /precheck — fast pre-push static verification

Runs typecheck and lint on **only the projects you've touched**, via Turborepo filters. Designed to feel like ~5–15s instead of the ~60s full-monorepo run.

## When to use

- Before committing changes
- Before pushing to a feature branch
- Whenever the agent finishes an edit and wants a quick sanity check

## When NOT to use

- For final pre-merge confidence, prefer the full `npm run typecheck && npm run test && npm run lint` (CI parity).
- For UI verification, use the built-in `/verify` skill (it runs the app).
- For dead-code / doc-rot audits, use `/cleanup`.

## Procedure

### 1. Determine which projects have changes

Resolve a comparison base, then list everything that has changed against it plus the working tree:

```bash
BASE=$(git rev-parse --verify --quiet '@{upstream}' 2>/dev/null \
    || git rev-parse --verify --quiet origin/main 2>/dev/null \
    || git rev-parse --verify --quiet main 2>/dev/null \
    || echo HEAD)
{ git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } | sort -u
```

Using only `git diff --name-only HEAD` would miss the case where the changes are already committed on the feature branch but not yet pushed — which is the most common pre-push moment for this skill.

Map each path to a project by its top-level directory:

| Path prefix                                                                       | Project                         |
| --------------------------------------------------------------------------------- | ------------------------------- |
| `kioku/...`                                                                       | `kioku`                         |
| `kokoro/...`                                                                      | `kokoro`                        |
| `kizuna/...`                                                                      | `kizuna`                        |
| `kansoku/...`                                                                     | `kansoku`                       |
| `kao/...`                                                                         | `kao`                           |
| `shared/packages/...`                                                             | _all_ (every consumer rebuilds) |
| root files (`package.json`, `turbo.json`, `dev-all.sh`, `vitest.config.ts`, etc.) | _all_                           |

If `shared/` or root files changed, **fall back to the full run** — drop filters and execute `npm run typecheck && npm run lint` across the workspace.

### 2. Build the Turborepo filter

For each affected project, include `--filter="@<project>/*"`. Examples:

- Touched only `kokoro/apps/bot/src/...` → `--filter="@kokoro/*"`
- Touched `kokoro/apps/bot/src/...` and `kizuna/apps/api/src/...` → `--filter="@kokoro/*" --filter="@kizuna/*"`

### 3. Run typecheck + lint in parallel

```bash
npx turbo run typecheck lint <filters>
```

Turbo runs the two tasks in parallel by default. Both have local cache; warm runs are near-instant.

If no projects are detected as changed (clean tree) report "no changes detected — nothing to precheck" and stop.

### 4. Report

- **Pass** → one line: `precheck passed: <project-list>` (e.g. `precheck passed: kokoro, kizuna`).
- **Fail** → surface only the first failing task's stderr tail (last ~20 lines), then point the user at the full command — `npm run typecheck` / `npm run lint`, or `npx turbo run <task> --filter='@<project>/*'` for project-scoped output. Use single quotes around the filter so shells with `failglob` (zsh, opt-in bash) don't try to expand `*`.

Do not paste the full turbo output back to the user — it's noisy. Keep the response under ~15 lines.

### Optional: add tests

If the user passes `--with-tests` (or asks "precheck with tests"), include the `test` task:

```bash
npx turbo run typecheck lint test <filters>
```

Tests are slower (~10–30s per project due to `mongodb-memory-server` bootstrap), so they are opt-in. If `shared/packages/{llm,logger}` was touched, tests across every consumer are required — fall back to `npm run test`.

### Optional: scope to one project

If the user passes a project name (e.g. `/precheck kokoro`), skip the git-diff step and just run with that filter directly.

## Notes

- This skill is a thin wrapper around Turborepo's filter + caching. It does not modify files.
- If you discover a real bug while running precheck (e.g. a typecheck error in code you didn't touch), report it but do not auto-fix — that's a separate task.
- For an even faster check on a single file, `tsc --noEmit -p <project>/apps/api/tsconfig.json` works but bypasses Turbo's cache and misses cross-package errors.
