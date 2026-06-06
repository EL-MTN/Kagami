import { AlertTriangle, CheckCircle2, CircleHelp, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AttentionSeverity, ServiceState } from "@/lib/types";

const stateStyle: Record<ServiceState, string> = {
  ok: "border-positive/25 bg-positive/10 text-positive",
  warn: "border-caution/30 bg-caution/10 text-caution",
  down: "border-critical/30 bg-critical/10 text-critical",
  unknown: "border-border bg-muted text-muted-foreground",
};

const severityStyle: Record<AttentionSeverity, string> = {
  critical: "border-critical/30 bg-critical/10 text-critical",
  warning: "border-caution/30 bg-caution/10 text-caution",
  info: "border-primary/25 bg-primary/10 text-primary",
};

export function StateBadge({ state }: { state: ServiceState }) {
  const Icon =
    state === "ok"
      ? CheckCircle2
      : state === "warn"
        ? AlertTriangle
        : state === "down"
          ? AlertTriangle
          : CircleHelp;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium capitalize",
        stateStyle[state],
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {state}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: AttentionSeverity }) {
  const Icon = severity === "info" ? Info : AlertTriangle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium capitalize",
        severityStyle[severity],
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {severity}
    </span>
  );
}
