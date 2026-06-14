"use client";

import { cn } from "@/lib/utils";

const DEFAULT_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

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

interface LevelChipsProps {
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  levels?: string[];
}

/**
 * Controlled multi-select chip group for log levels. Each chip toggles its
 * membership in `value`, emitting a fresh Set on every change so callers can
 * keep it in React state.
 */
export function LevelChips({ value, onChange, levels = DEFAULT_LEVELS }: LevelChipsProps) {
  function toggle(level: string) {
    const next = new Set(value);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    onChange(next);
  }

  return (
    <div className="flex flex-wrap gap-1">
      {levels.map((level) => {
        const on = value.has(level);
        return (
          <button
            key={level}
            type="button"
            onClick={() => toggle(level)}
            aria-pressed={on}
            className={levelChipClassName(on)}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
