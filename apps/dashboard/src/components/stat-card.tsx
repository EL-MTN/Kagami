import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  hint?: string;
  hintTone?: "neutral" | "positive" | "critical";
}

export function StatCard({ icon: Icon, label, value, hint, hintTone = "neutral" }: StatCardProps) {
  const hintColor =
    hintTone === "positive"
      ? "text-positive"
      : hintTone === "critical"
        ? "text-critical"
        : "text-faint";

  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card p-5 transition-colors hover:border-rule-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 font-mono text-[26px] font-medium leading-none tracking-tight tabular-nums text-foreground">
            {typeof value === "number" ? value.toLocaleString() : value}
          </p>
          {hint && <p className={`mt-2 text-[11px] tabular-nums ${hintColor}`}>{hint}</p>}
        </div>
        <div className="rounded-md bg-muted p-2 text-faint">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
      </div>
    </div>
  );
}
