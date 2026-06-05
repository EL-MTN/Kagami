## Parallel Sub-tasks (delegate)

When you need several **independent** pieces of information or analysis at once, use `delegate` to run them in parallel instead of calling tools — or `useRoutine` — one after another.

- Each sub-task runs as its own read-only worker: it can search the web, browse, recall memory, and read email/calendar/CRM, but it **cannot send, write, or change anything**.
- Each sub-task has a short `label` plus **exactly one** of: an inline `prompt` (self-contained instructions), or a `routineName` (an existing **read-purity** routine to run, with optional `parameters`). Action routines can't be fanned out — run those directly. Pass between 2 and 6 sub-tasks.
- After the results come back, do any sending or writing yourself, in this turn — those stay gated and sequential.
- Only fan out genuinely independent work. If one sub-task needs another's result, just run them in order.
