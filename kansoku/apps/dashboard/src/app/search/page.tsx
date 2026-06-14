import { Search } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { LogRow } from "@/components/log-row";
import { ServiceSelect } from "@/components/service-select";
import { levelChipFormClassName } from "@/components/level-chips";
import type { StoredLog } from "@/lib/api";
import { searchLogs, listServiceNames } from "@/lib/api";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];

interface SearchPageProps {
  searchParams: Promise<{
    service?: string;
    level?: string | string[];
    since?: string;
    until?: string;
    limit?: string;
  }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const service = params.service ?? "";
  // `level` arrives as a string for one checkbox, an array for several, or
  // absent for none — normalize to a deduped array so a single value and a
  // list share one code path.
  const selectedLevels = [...new Set(([] as string[]).concat(params.level ?? []))];
  const since = params.since ?? "";
  const until = params.until ?? "";
  const limitStr = params.limit ?? "100";
  const limit = Math.min(Math.max(Number.parseInt(limitStr, 10) || 100, 1), 1000);

  const names = await listServiceNames();

  const hasFilter = Boolean(service || selectedLevels.length || since || until);

  // Pre-validate the date strings client-side so a typo ("yesterday")
  // surfaces a friendlier error than the API's raw `kansoku /v1/logs →
  // 400 Bad Request`. An empty string means "not set" — only flag
  // non-empty, non-parseable inputs.
  function validIso(s: string): boolean {
    return s === "" || !Number.isNaN(Date.parse(s));
  }
  const sinceInvalid = !validIso(since);
  const untilInvalid = !validIso(until);

  // With no filters at all, default to the last 15 minutes so the page lands
  // on recent activity instead of a "press Run" prompt. The user's explicit
  // `since` still wins; this only fills the gap.
  const effectiveSince = hasFilter
    ? since || undefined
    : new Date(Date.now() - 15 * 60_000).toISOString();
  const usingDefaultWindow = !hasFilter;

  let logs: StoredLog[] = [];
  let error: string | undefined;
  if (sinceInvalid || untilInvalid) {
    error = `Invalid ISO timestamp: ${sinceInvalid ? "Since" : ""}${
      sinceInvalid && untilInvalid ? ", " : ""
    }${untilInvalid ? "Until" : ""}. Use e.g. 2026-05-14T00:00:00Z.`;
  } else {
    try {
      const res = await searchLogs({
        service: service || undefined,
        level: selectedLevels.length ? selectedLevels : undefined,
        since: effectiveSince,
        until: until || undefined,
        limit,
      });
      logs = res.logs;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Search"
        description="Query the persisted log store. Filters compose with AND; pagination by time-range."
        meta={
          <span className="text-[11px] tabular-nums text-faint">
            {logs.length.toLocaleString()} result{logs.length === 1 ? "" : "s"}
            {usingDefaultWindow ? " · last 15m" : ""}
          </span>
        }
      />

      <form method="get" className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-[1fr_1fr_1fr_120px_auto] gap-3">
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Service
            <ServiceSelect name="service" defaultValue={service} services={names} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Since (ISO)
            <input
              name="since"
              defaultValue={since}
              placeholder="2026-05-14T00:00:00Z"
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Until (ISO)
            <input
              name="until"
              defaultValue={until}
              placeholder="now"
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Limit
            <input
              name="limit"
              type="number"
              min={1}
              max={1000}
              defaultValue={limitStr}
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="self-end rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Search className="mr-1 inline h-3.5 w-3.5" strokeWidth={2} />
            Run
          </button>
        </div>
        <div className="mt-3 flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
          Level
          {/* Native checkboxes (not the controlled <LevelChips> client component)
              so the GET <form> still submits them natively as repeated
              `level` params. The label styling mirrors the tail chips. */}
          <div className="flex flex-wrap gap-1 normal-case">
            {LEVELS.map((l) => (
              <label key={l} className={levelChipFormClassName()}>
                <input
                  type="checkbox"
                  name="level"
                  value={l}
                  defaultChecked={selectedLevels.includes(l)}
                  className="sr-only"
                />
                {l}
              </label>
            ))}
          </div>
        </div>
      </form>

      {error && (
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {error}
        </div>
      )}

      {!error && logs.length === 0 ? (
        <EmptyState>No logs matched.</EmptyState>
      ) : logs.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-2 text-[11px] tabular-nums text-faint">
            Newest first · {logs[0] ? formatRelative(logs[0].ts) : "—"} →{" "}
            {logs.at(-1) ? formatRelative(logs.at(-1)!.ts) : "—"}
          </div>
          <div>
            {logs.map((log, i) => (
              <LogRow key={`${log.ts}-${i}`} log={log} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
