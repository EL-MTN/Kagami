"use client";

import { levelChipClassName } from "./level-chip-styles";

const DEFAULT_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

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
