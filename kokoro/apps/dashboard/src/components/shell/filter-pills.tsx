"use client";

export interface FilterPillOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional count badge shown after label. */
  count?: number;
}

interface ControlledProps<T extends string> {
  options: readonly FilterPillOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Controlled, client-driven segmented pill bar. For URL-driven (link) pills
 * use `LinkFilterPills` from the same module — that one is a server component
 * because Next.js cannot serialize an `hrefFor` function across the
 * server/client boundary.
 */
export function FilterPills<T extends string>({ options, value, onChange }: ControlledProps<T>) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border text-xs">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`px-2.5 py-1 transition-colors ${
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <span className="capitalize">{opt.label}</span>
            {opt.count !== undefined && (
              <span className={`ml-1.5 tabular-nums ${active ? "text-primary" : "text-faint"}`}>
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
