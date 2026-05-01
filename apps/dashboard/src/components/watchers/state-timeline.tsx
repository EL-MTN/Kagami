import type { WatcherStateChange } from "@/lib/queries/watchers";

interface StateTimelineProps {
  changes: WatcherStateChange[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function StateTimeline({ changes }: StateTimelineProps) {
  if (changes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
        <p className="text-sm text-faint">
          No distinct state observations yet — the watcher hasn&apos;t completed a run with a
          recorded state.
        </p>
      </div>
    );
  }

  return (
    <ol className="relative space-y-5 border-l border-border pl-6">
      {changes.map((change, idx) => {
        const isLatest = idx === 0;
        return (
          <li key={change.logId} className="relative">
            <StateMarker triggered={change.triggered} suppressed={change.suppressed} />

            <div className="flex items-baseline justify-between gap-4">
              <span
                className="text-[11px] tabular-nums text-muted-foreground"
                title={new Date(change.observedAt).toLocaleString()}
              >
                {formatRelative(change.observedAt)}
              </span>
              <div className="flex items-center gap-2">
                {isLatest && (
                  <span className="text-[10px] uppercase tracking-[0.15em] text-faint">latest</span>
                )}
                <StatePill triggered={change.triggered} suppressed={change.suppressed} />
              </div>
            </div>

            <div className="mt-2 rounded-md border border-border bg-card p-3">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                {change.newState}
              </p>
              {change.prevState && (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="kicker mb-1.5 text-[10px]">Was</p>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground line-through decoration-rule-strong">
                    {change.prevState}
                  </p>
                </div>
              )}
              {change.summary && change.summary !== change.newState && (
                <p className="mt-3 border-t border-border pt-3 text-[11px] italic text-muted-foreground">
                  {change.summary}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Filled disc = triggered, hollow ring = silenced, hairline tick = observation. */
function StateMarker({
  triggered,
  suppressed,
}: {
  triggered: boolean | null;
  suppressed: boolean;
}) {
  if (triggered && !suppressed) {
    return (
      <span className="absolute -left-[31px] top-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-critical ring-4 ring-card" />
    );
  }
  if (triggered && suppressed) {
    return (
      <span className="absolute -left-[31px] top-1.5 flex h-3 w-3 items-center justify-center rounded-full border-2 border-caution bg-card ring-4 ring-card" />
    );
  }
  return (
    <span className="absolute -left-[28px] top-2 h-[2px] w-2.5 rounded-full bg-muted-foreground" />
  );
}

function StatePill({ triggered, suppressed }: { triggered: boolean | null; suppressed: boolean }) {
  if (triggered && !suppressed) {
    return (
      <span className="rounded-full border border-critical/30 bg-critical/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-critical">
        triggered
      </span>
    );
  }
  if (triggered && suppressed) {
    return (
      <span className="rounded-full border border-caution/30 bg-caution/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-caution">
        silenced
      </span>
    );
  }
  return <span className="text-[10px] uppercase tracking-[0.12em] text-faint">observation</span>;
}
