/**
 * How the user is addressed in model-facing text (tool descriptions, refusal
 * envelopes, approval-bubble copy). Single constant so a persona change is one
 * edit instead of a sweep across every tool file. The prose context files
 * (`context/soul.md`, `context/instructions/*.md`) still spell it out — they
 * are persona artifacts edited as a set.
 */
export const OWNER = "Goshujin-sama";
