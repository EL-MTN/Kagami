import Link from "next/link";

interface LinkFilterOption<T extends string = string> {
  value: T;
  label: string;
  href: string;
  count?: number;
}

interface LinkFilterPillsProps<T extends string> {
  options: readonly LinkFilterOption<T>[];
  active: T;
}

/**
 * Server-component segmented pill bar. Each option carries its own resolved
 * href, so no function needs to cross the server/client boundary — that's why
 * this is a separate component from the controlled `FilterPills`.
 */
export function LinkFilterPills<T extends string>({ options, active }: LinkFilterPillsProps<T>) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border text-xs">
      {options.map((opt) => {
        const isActive = opt.value === active;
        return (
          <Link
            key={opt.value}
            href={opt.href}
            className={`px-2.5 py-1 transition-colors ${
              isActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            <span className="capitalize">{opt.label}</span>
            {opt.count !== undefined && (
              <span className={`ml-1.5 tabular-nums ${isActive ? "text-primary" : "text-faint"}`}>
                {opt.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
