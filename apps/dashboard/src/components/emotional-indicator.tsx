import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { EmotionalTrendPoint } from "@/lib/queries/overview";

interface EmotionalIndicatorProps {
  trend: EmotionalTrendPoint[];
}

export function EmotionalIndicator({ trend }: EmotionalIndicatorProps) {
  if (trend.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-faint">
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
  let toneClass: string;

  if (diff > 0.3) {
    icon = <TrendingUp className="h-3 w-3" />;
    label = "Rising";
    toneClass = "text-positive border-positive/30 bg-positive/8";
  } else if (diff < -0.3) {
    icon = <TrendingDown className="h-3 w-3" />;
    label = "Falling";
    toneClass = "text-critical border-critical/30 bg-critical/8";
  } else {
    icon = <Minus className="h-3 w-3" />;
    label = "Stable";
    toneClass = "text-muted-foreground border-border bg-muted";
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${toneClass}`}
    >
      {icon}
      {label}
      <span className="font-mono text-[10px] font-normal normal-case tracking-normal text-faint">
        {overall.toFixed(2)}
      </span>
    </span>
  );
}
