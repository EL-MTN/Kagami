import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { EmotionalTrendPoint } from "@/lib/queries/overview";

interface EmotionalIndicatorProps {
  trend: EmotionalTrendPoint[];
}

export function EmotionalIndicator({ trend }: EmotionalIndicatorProps) {
  if (trend.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
        <Minus className="h-3 w-3" />
        No data
      </span>
    );
  }

  const recent = trend.slice(-3);
  const older = trend.slice(0, -3);

  const recentAvg = recent.reduce((s, p) => s + p.avgTone, 0) / recent.length;
  const olderAvg =
    older.length > 0 ? older.reduce((s, p) => s + p.avgTone, 0) / older.length : recentAvg;

  const diff = recentAvg - olderAvg;
  const overall = trend.reduce((s, p) => s + p.avgTone, 0) / trend.length;

  let icon;
  let label: string;
  let colorClass: string;

  if (diff > 0.3) {
    icon = <TrendingUp className="h-3 w-3" />;
    label = "Rising";
    colorClass = "text-primary border-primary/25 bg-primary/5";
  } else if (diff < -0.3) {
    icon = <TrendingDown className="h-3 w-3" />;
    label = "Falling";
    colorClass = "text-destructive-foreground border-destructive/25 bg-destructive/5";
  } else {
    icon = <Minus className="h-3 w-3" />;
    label = "Stable";
    colorClass = "text-muted-foreground border-border";
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${colorClass}`}
    >
      {icon}
      {label}
      <span className="font-normal normal-case tracking-normal text-muted-foreground/60">
        ({overall.toFixed(1)})
      </span>
    </span>
  );
}
