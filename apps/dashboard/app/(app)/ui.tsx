import Link from "next/link";
import type { ReactNode } from "react";
import { Badge as BadgeBase } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export { PageHeader } from "@/components/shell/page-header";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border px-5 py-3">
      <h3 className="kicker">{children}</h3>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-faint">
      {children}
    </div>
  );
}

type BadgeTone = "default" | "green" | "amber" | "red" | "blue" | "zinc";

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: BadgeTone }) {
  const variant: Parameters<typeof BadgeBase>[0]["variant"] =
    tone === "green"
      ? "positive"
      : tone === "amber"
        ? "caution"
        : tone === "red"
          ? "critical"
          : tone === "blue"
            ? "default"
            : "muted";
  return <BadgeBase variant={variant}>{children}</BadgeBase>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  const tone: BadgeTone =
    channel === "email"
      ? "blue"
      : channel === "calendar"
        ? "amber"
        : channel === "in_person" || channel === "call"
          ? "green"
          : "zinc";
  return <Badge tone={tone}>{channel}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone: BadgeTone =
    status === "open"
      ? "amber"
      : status === "done"
        ? "green"
        : status === "cancelled" || status === "dismissed"
          ? "red"
          : status === "snoozed"
            ? "zinc"
            : "default";
  return <Badge tone={tone}>{status}</Badge>;
}

export function DirectionBadge({ direction }: { direction: "i_owe" | "they_owe" }) {
  return (
    <Badge tone={direction === "i_owe" ? "amber" : "blue"}>
      {direction === "i_owe" ? "I owe" : "they owe"}
    </Badge>
  );
}

export function ErrorBlock({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-md border border-critical/30 bg-critical/8 p-4 text-sm text-critical">
      <p className="font-medium">{title}</p>
      {detail ? (
        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-critical/80">{detail}</pre>
      ) : null}
    </div>
  );
}

export function PersonLink({ id, name }: { id: string; name: string | null }) {
  return (
    <Link
      href={`/people/${id}`}
      className="text-foreground underline decoration-border underline-offset-2 transition-colors hover:decoration-rule-strong hover:text-primary"
    >
      {name ?? "(unnamed)"}
    </Link>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {children}
    </code>
  );
}
