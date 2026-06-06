---
name: env-audit
description: Audit environment-variable symmetry across the Kagami workspace. For each project, cross-checks the Zod schema / env-resolution code, the .env.example template, the project's docs/configuration.md, and the workspace ARCHITECTURE.md "Configuration cheat sheet". Reports vars that are defined in code but missing from .env.example (broken setup experience), in .env.example but not in code (dead doc), or in code/.env.example but missing from ARCHITECTURE.md (operator-blind). Use after adding, renaming, or removing an env var — or whenever a config-touching PR is about to land. Trigger phrases include "env audit", "env drift", "are env vars in sync", "missing env doc", "audit configuration".
---

# /env-audit — env-var symmetry check

Adding an env var means touching 4 places. Missing any one of them is a real but easy-to-overlook bug:

| Source                                        | Symptom when missing                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Zod schema / env-resolution in code           | Service silently uses the wrong default or throws on the wrong line     |
| `.env.example`                                | New contributor's first run errors with no signal of what to set        |
| Project's `docs/configuration.md`             | Operator doesn't know the var exists                                    |
| `ARCHITECTURE.md` "Configuration cheat sheet" | Cross-service operator doesn't see this lever in the workspace overview |

This skill audits all four columns per project.

## Scope

Five projects, each with its own Zod source-of-truth and `.env.example` files:

| Project | Source of truth                                                                  | `.env.example`                                                          | Per-project doc                 |
| ------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Kioku   | `kioku/apps/api/src/llm.ts` + scattered `process.env.*` reads in `apps/api/src/` | `kioku/apps/api/.env.example` + `kioku/apps/dashboard/.env.example`     | `kioku/docs/configuration.md`   |
| Kokoro  | `kokoro/packages/shared/src/config.ts` (the canonical Zod schema)                | `kokoro/apps/bot/.env.example`                                          | (none — uses AGENTS.md inline)  |
| Kizuna  | `kizuna/apps/api/src/config.ts`                                                  | `kizuna/apps/api/.env.example` + `kizuna/apps/dashboard/.env.example`   | `kizuna/docs/configuration.md`  |
| Kansoku | `kansoku/apps/api/src/server.ts` (env resolution at boot)                        | `kansoku/apps/api/.env.example` + `kansoku/apps/dashboard/.env.example` | `kansoku/docs/configuration.md` |
| Kao     | `kao/apps/api/src/config.ts`                                                     | `kao/apps/api/.env.example` + `kao/apps/dashboard/.env.example`         | `kao/docs/configuration.md`     |

Plus the workspace-level `ARCHITECTURE.md` "Configuration cheat sheet" (the `## Configuration cheat sheet` section near the bottom).

## Procedure

### 1. Pick scope

- **Default** (no args): audit all five projects.
- `/env-audit <project>`: audit one project (`kioku` | `kokoro` | `kizuna` | `kansoku` | `kao`).

### 2. For each in-scope project, extract the four lists

**Code (source of truth):**

- Read the Zod schema file (table above) and list every key inside the `z.object({ ... })`. For projects with scattered `process.env.*` reads, also grep `process.env\.\([A-Z_][A-Z0-9_]*\)` in that project's `apps/*/src/` and union the result.
- Note which keys are required (no `.optional()` or `.default(...)`) vs optional.

**Templates:**

- Read each `.env.example` (api + dashboard) and list every key on the LHS of `=`.
- Note which keys are commented-out / placeholder values.

**Per-project doc:**

- If `docs/configuration.md` exists, list every env var mentioned (uppercase tokens, usually in headings or inline code).

**Cheat sheet:**

- Read the `## Configuration cheat sheet` section of `ARCHITECTURE.md`. For the project's row, list every env var mentioned.

### 3. Compute the symmetric differences

For each unique env var across all four lists, classify:

| Class                   | Code | .env.example | docs/configuration.md | ARCHITECTURE.md                                            |
| ----------------------- | ---- | ------------ | --------------------- | ---------------------------------------------------------- |
| **OK**                  | ✓    | ✓            | ✓ (or N/A)            | ✓ (or skipped intentionally)                               |
| **BROKEN SETUP**        | ✓    | ✗            | —                     | —                                                          |
| **DEAD DOC (example)**  | ✗    | ✓            | —                     | —                                                          |
| **DEAD DOC (cheat)**    | ✗    | —            | —                     | ✓                                                          |
| **OPERATOR-BLIND**      | ✓    | ✓            | ✗                     | ✗                                                          |
| **CROSS-SERVICE BLIND** | ✓    | ✓            | ✓                     | ✗ (and var is cross-service — paired with another project) |

Cross-service vars (`KIOKU_URL`, `KIZUNA_URL`, `KANSOKU_URL`, `KAO_URL`, `KAO_TOKEN`, etc.) MUST appear in `ARCHITECTURE.md`. Single-service vars (the project's own Mongo URI, internal feature gates) can skip ARCHITECTURE.md.

### 4. Report

```
=== <project> env audit ===

BROKEN SETUP (in code, missing from .env.example):
  - SOME_NEW_VAR (referenced in apps/api/src/config.ts:42)

DEAD DOC (in .env.example or docs, no longer in code):
  - OLD_VAR (still in apps/api/.env.example:18, removed from config.ts in <git blame summary>)

OPERATOR-BLIND (in code + example, no operator documentation):
  - FEATURE_TOGGLE_X (missing from docs/configuration.md and ARCHITECTURE.md cheat sheet)

CROSS-SERVICE BLIND (cross-service var missing from ARCHITECTURE.md cheat sheet):
  - NEW_SERVICE_URL (visible in code + example + docs/configuration.md, missing from workspace cheat sheet)

OK: <count> vars are in sync.
```

Keep the per-project section under ~20 lines; one bullet per finding.

### 5. Don't auto-fix

Most findings have a default fix (add the missing entry), but a few need judgment:

- Was the var renamed (drift in code only) or removed (intentional)? Check `git log -S <var>` on the source file.
- Is the var marketed as "internal" (e.g. test-only)? Then docs absence may be intentional.

Ask before editing — surface findings and the recommended action, but wait for approval.

## Notes

- This skill does NOT validate that the Zod schema's defaults match the values in `.env.example`. That's a separate class of check (would require running the parser on the example) and out of scope here.
- For drift in non-env content (CLI flags, route paths, AI tool actions), see `/doc-drift`.
- For dead file paths in docs, see `/cleanup`.
- ARCHITECTURE.md's cheat sheet is selective by design — not every env var belongs there. The rule is: vars that other services or operators rely on (cross-service URLs, shared secrets, tunables that affect runtime behavior) go in; per-service plumbing (internal Mongo URIs, debug flags) stays out.
