---
name: doc-drift
description: Audit the Kagami workspace for prose docs that reference code shapes that no longer exist — beyond the file-path scope of /cleanup. Looks at SEMANTIC drift: AI-tool action names in Kokoro's prompt/context files, CLI flags in skill docs, env var names in AGENTS.md / ARCHITECTURE.md, route paths in per-project docs, function/symbol names that have been renamed. Use after changing AI tool definitions, skill commands, CLI flags, env vars, route paths, or any boundary between prose and code. Trigger phrases include "audit doc drift", "prompt drift", "are the docs in sync", "are the instructions stale", "instructions out of date", "doc drift beyond paths".
---

# /doc-drift — semantic doc-rot audit

Catches the class of bug where prose describes a code shape that no longer exists. Distinct from [`/cleanup`](../cleanup/SKILL.md), which finds dead **file paths** in markdown — this skill finds dead **identifiers, flags, env vars, route paths, and tool actions**.

Concrete examples this skill is designed to catch (from recent commits):

- `apps/bot/context/instructions/browser.md` referenced an `inline_agent` action after the action was removed from the tool definition → silent LLM rejection at runtime.
- `.Codex/skills/kansoku-debug/SKILL.md` used `--service kokoro` in examples but the actual service-name filter expects `kokoro-bot` → silent no-op filtering.
- A `AGENTS.md` "Where to find things" row pointed at `apps/dashboard/app/(app)/...` after the route group was removed → broken navigation for the next agent.

## Scope

Markdown the skill audits (in priority order):

1. **Kokoro AI prompts / context** — these drift fastest because the LLM sees them verbatim:
   - `kokoro/apps/bot/context/soul.md`
   - `kokoro/apps/bot/context/instructions/*.md`
2. **`.Codex/skills/*/SKILL.md`** — agent-facing instructions; bad examples here propagate to every invocation.
3. **`AGENTS.md` at every level** — workspace root + 5 per-project.
4. **`ARCHITECTURE.md`** — especially the "Configuration cheat sheet" and edge tables.
5. **Per-project `docs/*.md`** (kioku/docs, kokoro/docs, kizuna/docs, kansoku/docs, kao/docs).

## Procedure

### 1. Pick the right blast radius

- **Default** (no args): audit all five categories above.
- `/doc-drift <project>` → only that project's AGENTS.md + docs/ + (for kokoro) context/instructions.
- `/doc-drift kokoro-prompts` → only Kokoro's `context/` and `instructions/` (the highest-value subset; do this after every AI-tool change).
- `/doc-drift skills` → only `.Codex/skills/*/SKILL.md`.

### 2. Extract candidate references from prose

For each in-scope markdown file, pull out tokens that look like they reference code:

- **Inline-code spans**: `` `someName` `` (function, command, flag, env var, route, file).
- **Tool/action names** in Kokoro prompts — usually appear as plain words next to verbs ("calls X", "uses the Y action").
- **CLI flag examples** — `--service`, `--filter`, `--with-tests`, etc.
- **Env var names** — uppercase tokens with underscores, often inside inline code.
- **Route paths** — strings starting with `/` followed by a non-space sequence.

Skip obvious literals: command names like `npm`, `git`, `tsc`; English words in code spans (e.g. `` `the` `` — unlikely).

### 3. Cross-check each candidate against current code

For each candidate token, decide where it would be defined and look:

| Token shape                                 | Where to verify it exists                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AI tool / action name (e.g. `inline_agent`) | `kokoro/apps/bot/src/ai/tools/*.ts` — look for matching `tool({ name: "..." })` or `actions: ["..."]` |
| Skill name (e.g. `precheck`, `cleanup`)     | `.Codex/skills/<name>/SKILL.md` frontmatter                                                           |
| CLI flag (e.g. `--with-tests`)              | The skill's own procedure section + the script it invokes                                             |
| Env var (e.g. `KAO_TOKEN`)                  | Zod schema in `config.ts` / `server.ts` + matching `.env.example` (use /env-audit for fuller check)   |
| Route path (e.g. `/grants/:grant/token`)    | The corresponding `routes/*.ts` file in the appropriate service                                       |
| Function/symbol name                        | Grep the relevant source dir                                                                          |

If a candidate has no current definition, that's a drift finding.

### 4. Report

Group findings by markdown file. For each:

```
<path/to/file.md>:<line>
  reference: `someName`
  expected:  AI tool action in kokoro/apps/bot/src/ai/tools/*.ts
  reality:   no matching `tool({ name: "someName" })` or `actions: ["someName"]` found
  suggest:   the closest current match is `otherName` in apps/bot/src/ai/tools/browse.ts
```

Keep the report short (≤30 findings, most-severe first). Severity ranking:

1. **Critical** — Kokoro AI prompt or instruction referencing a removed tool/action (LLM-visible, runtime impact).
2. **High** — skill doc with wrong example (every agent invocation propagates the bug).
3. **Medium** — AGENTS.md / ARCHITECTURE.md describing wrong shape (slows agent navigation, no runtime impact).
4. **Low** — per-project docs/\*.md with stale signal name.

### 5. Don't auto-fix

Surface drift for the user to acknowledge. Some drift is intentional (e.g. a doc describing a planned change). Ask before editing.

## Notes

- This skill is **not** dead-file-path detection — that's `/cleanup`'s doc-rot scanner. If `/doc-drift` finds a non-existent file path, defer to `/cleanup`.
- This skill is **not** type-checking — TypeScript's `tsc --noEmit` (via `/precheck`) catches signature drift in code. The skill catches drift between code and prose.
- For env-var drift specifically, prefer `/env-audit` — it is more thorough about config/example/docs symmetry.
