---
name: cleanup
description: Scan the Kagami workspace for dead code, unused imports, and doc rot. Fans out one subagent per microservice, aggregates findings into a single Markdown report, and (with --apply) deletes high-confidence dead code. Use when the user asks to clean up, find dead code, find unused imports/exports/files, audit for rot, or maintain hygiene across the monorepo.
---

# /cleanup — dead-code & doc-rot audit

Audits every project in the Kagami nested monorepo for:

1. **Dead code** — unused files, exports, types, members, and dependencies (via [knip](https://knip.dev))
2. **Dead imports / locals** — unused imports and locals (knip + TypeScript)
3. **Doc rot** — file paths and identifiers referenced in `.md` files that no longer exist in the codebase (custom scanner)

Knip is TypeScript-aware: it walks the actual module graph from configured
entrypoints, so it finds things grep cannot — exports nothing imports,
files no entrypoint reaches, dependencies declared in `package.json` but
never required, types nobody consumes.

## Invocation

- `/cleanup` — report only. Writes `.claude/reports/dead-code-YYYY-MM-DD.md`.
- `/cleanup --apply` — report + delete the high-confidence dead code (see "Apply mode" below).
- `/cleanup <project>` — limit scope to one project (`kioku` | `kokoro` | `kizuna` | `kansoku` | `kao` | `shared`).

## Procedure

### 1. Confirm knip is installed

```bash
npx knip --version
```

If it errors with "command not found", instruct the user to run `npm install` from the repo root (the dep is declared in the workspace `package.json` and `knip.json` is committed).

### 2. Run knip once across the whole workspace

```bash
npx knip --reporter json > /tmp/knip-out.json 2>/tmp/knip-err.log || true
```

Knip exits non-zero when it finds issues — that's expected, not a failure. Inspect `/tmp/knip-err.log` only if `/tmp/knip-out.json` is empty or malformed.

### 3. Fan out — spawn one subagent per project, in parallel

Use the `Agent` tool with `subagent_type: "general-purpose"`, sending all calls in a **single message** so they run concurrently. One agent per:

- `kioku`
- `kokoro`
- `kizuna`
- `kansoku`
- `kao`
- `shared` (covers `shared/packages/*`)

Each subagent's prompt should include:

- The slice of the knip JSON that pertains to its project (filter by `path` prefix)
- An instruction to run the doc scanner: `node .claude/skills/cleanup/scripts/doc-scan.mjs <projectRoot>`
- The verification checklist below
- The output contract: write findings to `.claude/reports/_partial-<project>.md` and return a short summary

#### Subagent verification checklist

Knip and the doc scanner can flag things that are intentionally alive. Before including a finding in the partial report, the subagent must:

- **Unused exports**: confirm no sibling project imports the symbol. Cross-check with `rg "from ['\\\"]@<scope>/<package>['\\\"]"` across the whole repo. Public package APIs (anything in `shared/packages/*` that's documented in `ARCHITECTURE.md` or the package's own `CLAUDE.md`) get downgraded to LOW confidence.
- **Unused files**: confirm the file is not a route loaded dynamically (Next.js dashboards), a script invoked from `package.json` scripts, or a Telegram/iMessage handler registered by side effect. Check `apps/*/package.json` scripts and any registration files (`index.ts` of platform/services modules).
- **Unused dependencies**: confirm the dep isn't referenced via dynamic require, a CLI subcommand, or as a peer of a built tool (e.g. `eslint` plugins). Per-app `package.json` is the source of truth, not the workspace root.
- **Doc-rot file refs**: open the markdown line and check whether the path was always conceptual (e.g. an example, a placeholder like `<contract>.test.ts`). Skip if the surrounding prose makes it clear.
- **Doc-rot symbol refs**: confirm the symbol genuinely doesn't appear anywhere in source. The scanner is permissive (it accepts any token occurrence), so any hits it reports are strong signal.

Confidence ratings the subagent should attach to each finding:

- **HIGH** — knip says unused AND no cross-project import AND not a registered entry point. Or: doc scanner found a file/symbol ref with zero matches anywhere in source.
- **MEDIUM** — knip says unused, but it's an exported symbol from a `shared/*` package, OR a file that _might_ be dynamically loaded. Needs human eyes.
- **LOW** — heuristic hit, but the subagent isn't confident.

### 4. Aggregate — main agent merges partials into the final report

After all subagents return, read `.claude/reports/_partial-<project>.md` for each project and assemble them into `.claude/reports/dead-code-YYYY-MM-DD.md` with this structure:

```markdown
# Dead code & doc rot — <date>

<one-paragraph summary: total findings by confidence, per project>

## kioku

### HIGH confidence

- `path/to/file.ts:42` — unused export `foo` (knip)
- `kioku/docs/api.md` — references symbol `BarBaz` which no longer exists in source

### MEDIUM confidence

...

### LOW confidence

...

## kokoro

...

## Cross-project notes

<anything that touches multiple projects, e.g. a shared package export removed but a doc still names it>

## How to apply

Re-run with `/cleanup --apply` to delete HIGH-confidence findings automatically.
```

Then delete the partial files.

### 5. Apply mode (only if invoked with `--apply`)

After writing the report, delete HIGH-confidence findings in this order:

1. **Unused imports & unused locals** — run `npx eslint --fix --rule '{"@typescript-eslint/no-unused-vars": "error"}' <files>`, scoped to the files knip flagged.
2. **Unused exports of _internal_ (non-`shared/*`) symbols** — Edit the file to remove the `export` keyword, or delete the symbol entirely if knip also lists it as an unused member.
3. **Unused files** — `git rm` each file knip listed as unused, provided no MEDIUM finding overlaps.
4. **Unused dependencies** — Edit the relevant `package.json` to remove the entry. Do not run `npm install` — leave that to the user.

After applying, run:

```bash
npm run typecheck
npm run lint
```

If either fails, **revert all `--apply` changes** (`git checkout -- .` for unstaged, `git restore --staged .` for staged) and add a "rollback" section to the report explaining what failed. Do not push.

Never auto-apply to:

- Anything in `shared/packages/*` exports (public API; needs human review).
- `CLAUDE.md` / `ARCHITECTURE.md` / `docs/*.md` (doc updates need editorial judgment).
- Anything flagged MEDIUM or LOW.

### 6. Report back

End with a 1-2 sentence summary: total HIGH/MEDIUM/LOW counts, where the report was written, and (if `--apply` ran) what was deleted vs. rolled back.

## Files

- `knip.json` — workspace-level config; one entry per workspace (most are `{}` to opt into auto-detection)
- `.claude/skills/cleanup/scripts/doc-scan.mjs` — doc-reference scanner (zero deps, pure Node)
- `.claude/reports/` — gitignored; ephemeral output

## Extending

- New microservice → add a `workspaces["<project>/apps/foo"]` entry to `knip.json` naming the real entrypoint (knip's auto-detect handles Next.js / Vitest but not custom server `main.ts` / `server.ts` names).
- Tweak doc-scanner heuristics (extension list, identifier shape, exclusions) directly in `doc-scan.mjs`. The scanner is intentionally simple and dependency-free.
