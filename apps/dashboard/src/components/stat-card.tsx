import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
}

export function StatCard({ icon: Icon, label, value }: StatCardProps) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-card p-6 transition-all duration-300 hover:border-primary/20 hover:shadow-[0_0_24px_oklch(0.78_0.12_75_/_0.04)]">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 font-display text-3xl tracking-tight text-foreground">
            {typeof value === "number" ? value.toLocaleString() : value}
          </p>
        </div>
        <div className="rounded-lg bg-primary/5 p-2.5 text-primary/30 transition-colors group-hover:bg-primary/10 group-hover:text-primary/50">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}
