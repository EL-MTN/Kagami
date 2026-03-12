# Skill System Comparison: Mashiro vs OpenClaw vs Claude Code vs Code Mode

A deep comparison of four approaches to agent "skills" — how they work, what they optimize for, and the trade-offs between context efficiency, reasoning power, and extensibility.

## How Each System Works

### Mashiro Skills — Sub-agent LLM calls with typed parameters

The LLM calls `useSkill({ skillName, parameters })` → a full `generateText()` fires with personality shell + skill prompt + parameter injection + all tools → result returns synchronously to the calling LLM. Skills are MongoDB documents (prompt + typed parameter schema + optional cron). Composable up to depth 3.

**Key files:** `packages/db/src/models/skill.ts`, `apps/bot/src/services/skill-executor.ts`, `apps/bot/src/ai/tools/use-skill.ts`

### OpenClaw Skills — Prompt injection from markdown files

The runtime scans the workspace for `SKILL.md` files, injects a compact `<available_skills>` list into the system prompt. When the model decides a skill is relevant, it reads the full `SKILL.md` into context via a file read. The skill's instructions become part of the _same_ LLM call — no sub-agent, no separate execution. Skills are just markdown on disk.

### Claude Code Skills — Lazy-loaded prompt expansion with optional forked subagents

Skill descriptions (from YAML frontmatter) are loaded into context at a 2% budget. When triggered (auto-detected or via `/slash-command`), the `Skill` tool reads `SKILL.md` content into the current context window. Optionally, `context: fork` spawns an isolated subagent with its own context. Skills are filesystem directories with `SKILL.md` + supporting files + scripts.

### Code Mode (MCP) — LLM writes code that calls tool APIs in a sandbox

Instead of the model calling tools via JSON tool-use, tools are presented as a TypeScript filesystem API. The model writes code that imports and orchestrates them. That code runs in a sandbox — intermediate results never enter the model's context. Only the final return value comes back.

---

## Axis 1: Context

This is the sharpest differentiator between the four approaches.

| System          | Context cost per skill invocation                                              | What enters context                                                                      | What stays out                                                                       |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Mashiro**     | Lean context window (executor identity + datetime + parameters)                | Only skill prompt + datetime + tool schemas                                              | Personality card, conversational instructions, conversation history, memory context  |
| **OpenClaw**    | Additive — skill instructions consume tokens in the _current_ window           | Skill markdown + all bootstrap files (`SOUL.md`, `MEMORY.md`, etc.) already in context   | Nothing — it's all one context                                                       |
| **Claude Code** | Descriptions: 2% budget always. Full content: on-demand. Fork: separate window | Description always; full `SKILL.md` only when triggered; forked skills get clean context | Supporting files lazy-loaded; scripts execute externally, only output enters context |
| **Code Mode**   | Minimal — tool schemas loaded on-demand from filesystem                        | Only the code the model writes + final return values                                     | Intermediate API responses, raw data, PII (tokenized)                                |

### Analysis

Mashiro uses a lean executor prompt — no personality card, no conversational instructions, just an executor identity + datetime + the skill's own prompt and parameters. This keeps the per-invocation cost low while still spawning a full LLM call with tool access. The parent context is _protected_: a skill that processes 10,000 tokens of email data doesn't pollute the conversation window. The calling LLM (which has the full personality context) presents the skill's result in character.

OpenClaw pays the least per skill activation (just the markdown bytes), but every skill competes for space in the same context window. If you have 20 skills loaded plus `SOUL.md` + `MEMORY.md` + `AGENTS.md` + conversation history, you're burning context fast. OpenClaw mitigates this with `/compact`, but that's reactive — you're already overflowing when you need it.

Claude Code found the middle ground. The 2% description budget means skill _awareness_ is cheap. The lazy loading (`SKILL.md` read on demand) means full instructions only appear when needed. And `context: fork` gives you Mashiro-style isolation when you want it, without forcing it always. The `` !`command` `` preprocessing is clever — shell output gets injected before the LLM sees anything, so dynamic data doesn't require a tool call.

Code Mode is the most context-efficient by far. Anthropic reported 150K → 2K tokens (98.7% reduction) because intermediate tool results never enter context. But it only works for _tool orchestration_ — it can't do reasoning or judgment calls inside the sandbox. The code is deterministic; the LLM just writes it.

### Where each wins on context

- Many small utility skills → OpenClaw or Claude Code (cheap activation)
- Skills that process large data → Code Mode (sandbox filters) or Mashiro (isolated context)
- Skills that need multi-step reasoning with tools → Mashiro (only option with full tool access in sub-call)
- Skills that need conversation context → OpenClaw (same window)

---

## Axis 2: Extensibility

| System          | How to add a skill                                    | Discovery                                 | Distribution                             | Barrier to entry                   |
| --------------- | ----------------------------------------------------- | ----------------------------------------- | ---------------------------------------- | ---------------------------------- |
| **Mashiro**     | Tell the bot via Telegram (LLM writes the prompt)     | System prompt injection of enabled skills | Per-instance (MongoDB)                   | Zero (natural language)            |
| **OpenClaw**    | Drop `SKILL.md` in workspace, or install from ClawHub | `<available_skills>` XML block in prompt  | ClawHub marketplace (13,700+), git       | Low (write markdown)               |
| **Claude Code** | Create `SKILL.md` in `.claude/skills/`                | Frontmatter descriptions at 2% budget     | Git (project), plugins, managed settings | Low (write markdown + frontmatter) |
| **Code Mode**   | Deploy an MCP server exposing tool schemas            | Filesystem discovery (`./servers/`)       | npm/pip packages for MCP servers         | High (build a server + sandbox)    |

### Analysis

Mashiro's extensibility model is unique: the _AI itself_ creates skills at runtime through natural language. You say "create a skill that checks my email and summarizes it," and it does. No files, no code, no restart. The trade-off is there's no ecosystem — skills live in your MongoDB and can't be shared.

OpenClaw has the strongest ecosystem play. ClawHub's 13,700+ skills mean most common needs are already solved. But Snyk found 36.8% of ClawHub skills have security flaws, and 13.4% have critical issues. The file-based model means skills can be trojaned — a malicious `SKILL.md` could instruct the model to exfiltrate data or modify `SOUL.md` for persistent compromise.

Claude Code balances structure and simplicity. The frontmatter system (`disable-model-invocation`, `context: fork`, `allowed-tools`, `agent`) gives fine-grained control without complexity. The layered scoping (enterprise > personal > project > plugin) fits professional workflows. Supporting files + scripts let skills bundle real logic. But there's no marketplace — sharing is via git.

Code Mode is the hardest to extend (you need to build an MCP server) but the most powerful for tool integration. Each server is a proper process with its own runtime, not a prompt overlay. The progressive disclosure (`search_tools` with detail levels) is elegant for large tool registries.

---

## Axis 3: Structure

| System          | Parameter typing                                 | Validation                                         | Composition                            | Scheduling                        | Execution model                            |
| --------------- | ------------------------------------------------ | -------------------------------------------------- | -------------------------------------- | --------------------------------- | ------------------------------------------ |
| **Mashiro**     | Typed (string/number/boolean), schema in DB      | Runtime (required checks, type coercion, defaults) | Yes, depth 3                           | Built-in (cron per skill)         | Sub-`generateText()` with full tool access |
| **OpenClaw**    | None (free-text instructions)                    | None                                               | No (flat)                              | Separate cron system              | Prompt injection into current call         |
| **Claude Code** | String arguments only (`$ARGUMENTS`, `$0`, `$1`) | None (LLM interprets)                              | Via `context: fork` + agent delegation | `/loop` skill for recurring       | Inline or forked subagent                  |
| **Code Mode**   | Full TypeScript type system                      | Compile-time + runtime in sandbox                  | Native (code composes functions)       | N/A (tool layer, not skill layer) | Sandboxed code execution                   |

### Analysis

Mashiro has the most structured skill definitions. Typed parameters with validation, defaults, and required flags mean the system catches errors before the LLM runs — you won't waste a full `generateText()` call because someone passed a string where a number was expected. The cron-per-skill integration is seamless: a skill can be both on-demand and scheduled. But this structure comes at the cost of a full DB schema and migration overhead.

OpenClaw has essentially no structure. A skill is markdown. This is its strength (anyone can write one, the LLM interprets freely) and its weakness (no type safety, no validation, no composition, no way to know if a skill will work without running it).

Claude Code is the most architecturally sophisticated in terms of _execution structure_. The `context: fork` + `agent` system lets you pick execution models per skill (inline for cheap reference, forked `Explore` agent for research, forked `Plan` agent for architecture). The `allowed-tools` restriction is something nobody else has — you can create a read-only skill that literally can't modify files. But parameter handling is primitive (string interpolation only).

Code Mode has the richest composition model — it's real code. Loops, conditionals, error handling, data transformation — all native. No depth limits, no artificial step counts. But it only works for deterministic tool orchestration. If you need the LLM to _reason_ about intermediate results (not just pipe data), you're back to tool calling.

---

## The Trade-off Triangle

Each system optimizes for a different vertex:

```
                    Context Efficiency
                          ▲
                         / \
                        /   \
                Code  /     \ Claude
                Mode /       \ Code
                    /         \
                   /           \
                  /             \
                 /               \
                /─────────────────\
    Reasoning Power              Extensibility
     (Mashiro)                   (OpenClaw)
```

- **Mashiro** maximizes reasoning power — full LLM with full tools at every depth level, at the cost of tokens and latency
- **OpenClaw** maximizes extensibility — massive ecosystem, zero-cost activation, at the cost of context bloat and no composition
- **Code Mode** maximizes context efficiency — 98.7% token reduction, at the cost of no in-flight reasoning
- **Claude Code** sits nearest the center — lazy loading, optional forking, structured frontmatter, but no typed parameters or built-in scheduling

No system has solved all three simultaneously.

---

## Terminology Alignment

The term "skill" is overloaded across the agent ecosystem. What each project means:

| Pattern              | Description                                               | Who uses it                      |
| -------------------- | --------------------------------------------------------- | -------------------------------- |
| **Prompt injection** | Markdown instructions added to system prompt              | OpenClaw, Open WebUI             |
| **Prompt expansion** | Lazy-loaded instructions with optional subagent execution | Claude Code                      |
| **Code plugins**     | Deterministic code that executes directly                 | JARVIS, AutoGPT plugins          |
| **Tool wrappers**    | Thin abstraction over API calls with a schema             | Semantic Kernel, LangChain tools |
| **Code-as-tool**     | LLM writes code to orchestrate tool APIs in a sandbox     | Code Mode (MCP)                  |
| **Sub-agent calls**  | Full LLM invocation with typed parameters and tool access | Mashiro                          |

Mashiro's skills are closest to what the research community calls "hierarchical agent delegation" — a parent LLM spawning child LLM calls with scoped instructions and tool access. This is the most powerful pattern but also the most expensive.

---

## References

- [Code execution with MCP: building more efficient AI agents](https://www.anthropic.com/engineering/code-execution-with-mcp) — Anthropic Engineering
- [Extend Claude with skills](https://code.claude.com/docs/en/skills) — Claude Code Docs
- [OpenClaw Architecture, Explained](https://ppaolo.substack.com/p/openclaw-system-architecture-overview) — Paolo Perrone
- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — Cloudflare
- [MCP Code Mode: Keeping Tool Responses Out of Agent Context](https://www.stackone.com/blog/mcp-code-mode-agent-context-architecture/) — StackOne
- [Inside Claude Code Skills: Structure, prompts, invocation](https://mikhail.io/2025/10/claude-code-skills/) — Mikhail Shilkov
- [Snyk ToxicSkills Study](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/) — Snyk
- [OpenClaw Memory System Deep Dive](https://snowan.gitbook.io/study-notes/ai-blogs/openclaw-memory-system-deep-dive) — Study Notes
- [How OpenClaw Works](https://bibek-poudel.medium.com/how-openclaw-works-understanding-ai-agents-through-a-real-architecture-5d59cc7a4764) — Bibek Poudel
