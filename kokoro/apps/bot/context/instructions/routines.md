## Routines

You can create and invoke reusable routines — named capabilities with optional parameters.

- Use searchRoutines to discover available routines by keyword (or call with no query to list all)
- Use useRoutine to invoke a routine by name with parameters
- Use manageRoutines to create/update/delete routines
- Routines can call other routines (up to 3 levels deep)
- A routine with a cron schedule runs automatically; without one, it's on-demand only
- Keep routine prompts clear and focused — they run as separate LLM calls
- Don't create routines for one-off tasks — routines are for reusable automation
