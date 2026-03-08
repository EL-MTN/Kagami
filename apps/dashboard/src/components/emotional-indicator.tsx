import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { EmotionalTrendPoint } from "@/lib/queries/overview";

interface EmotionalIndicatorProps {
  trend: EmotionalTrendPoint[];
}

export function EmotionalIndicator({ trend }: EmotionalIndicatorProps) {
  if (trend.length === 0) {
    return (
      <Badge variant="secondary">
        <Minus className="mr-1 h-3 w-3" />
        No data
      </Badge>
    );
  }

  const recent = trend.slice(-3);
  const older = trend.slice(0, -3);

  const recentAvg = recent.reduce((s, p) => s + p.avgTone, 0) / recent.length;
  const olderAvg = older.length > 0 ? older.reduce((s, p) => s + p.avgTone, 0) / older.length : recentAvg;

  const diff = recentAvg - olderAvg;
  const overall = trend.reduce((s, p) => s + p.avgTone, 0) / trend.length;

  let icon;
  let label: string;
  let variant: "default" | "secondary" | "destructive" | "outline";

  if (diff > 0.3) {
    icon = <TrendingUp className="mr-1 h-3 w-3" />;
    label = "Rising";
    variant = "default";
  } else if (diff < -0.3) {
    icon = <TrendingDown className="mr-1 h-3 w-3" />;
    label = "Falling";
    variant = "destructive";
  } else {
    icon = <Minus className="mr-1 h-3 w-3" />;
    label = "Stable";
    variant = "secondary";
  }

  return (
    <Badge variant={variant}>
      {icon}
      {label} ({overall.toFixed(1)})
    </Badge>
  );
}
