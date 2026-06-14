import { cn } from "@/lib/utils";

/**
 * Pure level-chip className helpers. These live in a NON-client module (no
 * `"use client"`) so server components — e.g. the Search page's GET form —
 * can call them directly; a function exported from a `"use client"` module
 * becomes a client reference that the server cannot invoke. The interactive
 * `<LevelChips>` component (which needs client state) stays in
 * `level-chips.tsx` and imports `levelChipClassName` from here.
 */

/**
 * The toggle-chip className, factored out so native checkbox-driven pages can
 * style their labels identically to the controlled <LevelChips> buttons. The
 * look is copied verbatim from the tail-client level chips.
 */
export function levelChipClassName(active: boolean): string {
  return cn(
    "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
    active
      ? "border-primary/30 bg-primary/10 text-primary"
      : "border-border bg-background text-muted-foreground hover:text-foreground",
  );
}

/**
 * Chip className for a <label> wrapping a visually-hidden native checkbox (used
 * by GET-form pages that can't run the controlled <LevelChips>). The active
 * look and focus ring are driven by the checkbox's own state via `has-[]`
 * variants, so toggling gives instant feedback without a round-trip — matching
 * the controlled chips' behavior.
 */
export function levelChipFormClassName(): string {
  return cn(
    "cursor-pointer select-none rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
    "border-border bg-background text-muted-foreground hover:text-foreground",
    "has-[:checked]:border-primary/30 has-[:checked]:bg-primary/10 has-[:checked]:text-primary",
    "has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-primary/50",
  );
}
