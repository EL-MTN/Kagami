import { MessageSquare, Zap, Eye, Wrench } from "lucide-react";
import type { ConfirmationListItem } from "@/lib/queries/confirmations";

const ORIGIN_ICON = {
  conversation: MessageSquare,
  skill: Zap,
  watcher: Eye,
} as const;

function formatRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const past = ms < 0;

  const mins = Math.round(abs / 60_000);
  if (mins < 1) return past ? "just now" : "<1m";
  if (mins < 60) return past ? `${mins}m ago` : `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return past ? `${hours}h ago` : `${hours}h`;
  const days = Math.round(hours / 24);
  return past ? `${days}d ago` : `${days}d`;
}

interface ConfirmationCardProps {
  item: ConfirmationListItem;
  /** When true, shows status pill and resolved-at instead of expiry. */
  resolved?: boolean;
}

export function ConfirmationCard({ item, resolved = false }: ConfirmationCardProps) {
  const Icon = ORIGIN_ICON[item.origin] ?? Wrench;
  const argEntries = Object.entries(item.args);

  return (
    <div className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-rule-strong">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-muted p-1.5 text-muted-foreground">
            <Icon className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-relaxed text-foreground">{item.summary}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
              <span className="capitalize">{item.origin}</span>
              <span>·</span>
              <span className="font-mono">{item.tool}</span>
              <span>·</span>
              <span className="font-mono">{item.chatId}</span>
            </div>
          </div>
        </div>

        <div className="shrink-0 text-right">
          {resolved ? (
            <StatusPill status={item.status} />
          ) : (
            <span className="font-mono text-[11px] tabular-nums text-caution">
              expires in {formatRelative(item.expiresAt)}
            </span>
          )}
          <p
            className="mt-1 font-mono text-[11px] tabular-nums text-faint"
            title={new Date(item.createdAt).toLocaleString()}
          >
            {formatRelative(item.createdAt)}
          </p>
        </div>
      </div>

      {argEntries.length > 0 && (
        <details className="mt-3 ml-11">
          <summary className="cursor-pointer text-[11px] text-faint hover:text-muted-foreground">
            Args ({argEntries.length})
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {JSON.stringify(item.args, null, 2)}
          </pre>
        </details>
      )}

      {resolved && item.resultText && (
        <details className="mt-3 ml-11">
          <summary className="cursor-pointer text-[11px] text-faint hover:text-muted-foreground">
            Result
          </summary>
          <p className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            {item.resultText}
          </p>
        </details>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ConfirmationListItem["status"] }) {
  const tone =
    status === "approved"
      ? "text-positive bg-positive/10 border-positive/30"
      : status === "denied"
        ? "text-critical bg-critical/10 border-critical/30"
        : status === "cancelled"
          ? "text-muted-foreground bg-muted border-border"
          : status === "expired"
            ? "text-faint bg-muted border-border"
            : "text-primary bg-primary/10 border-primary/30";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}
    >
      {status}
    </span>
  );
}
