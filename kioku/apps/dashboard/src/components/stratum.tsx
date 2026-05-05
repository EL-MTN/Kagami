import { monthLabel } from "@/lib/format";

interface StratumLayer {
  monthKey: string;
  count: number;
}

interface StratumProps {
  layers: StratumLayer[];
}

/**
 * Memory stratum: facts grouped by event-date month rendered as horizontal
 * sediment-like layers, deepest (oldest) at the bottom. Each layer's width
 * is proportional to its share of the total; the count is set in the display
 * serif so the visual reads as something halfway between a chart and a
 * geological cross-section.
 */
export function Stratum({ layers }: StratumProps) {
  if (layers.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-faint">
        No dated facts yet — strata will form as memory accumulates.
      </p>
    );
  }

  const sorted = [...layers].sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  const max = Math.max(...sorted.map((l) => l.count), 1);
  const total = sorted.reduce((acc, l) => acc + l.count, 0);

  return (
    <div className="space-y-1.5">
      {sorted.map((layer, idx) => {
        const pct = (layer.count / max) * 100;
        const share = (layer.count / total) * 100;
        return (
          <div
            key={layer.monthKey}
            className="group grid grid-cols-[100px_1fr_auto] items-center gap-4"
            style={{ animation: `fade-in 0.4s ease-out both`, animationDelay: `${idx * 40}ms` }}
          >
            <div className="text-[11px] tabular-nums text-muted-foreground">
              {monthLabel(layer.monthKey)}
            </div>
            <div className="relative h-7 overflow-hidden rounded-sm bg-muted/60">
              <div
                className="h-full origin-left rounded-sm transition-colors group-hover:opacity-90"
                style={{
                  width: `${pct}%`,
                  background: `linear-gradient(90deg,
                    color-mix(in oklch, var(--color-positive) 18%, transparent) 0%,
                    color-mix(in oklch, var(--color-positive) 32%, transparent) 100%)`,
                }}
              />
              <div className="absolute inset-y-0 left-3 flex items-center">
                <span className="font-display text-[20px] leading-none text-foreground/85 tabular-nums">
                  {layer.count}
                </span>
              </div>
            </div>
            <div className="w-12 text-right font-mono text-[10px] tabular-nums text-faint">
              {share.toFixed(1)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}
