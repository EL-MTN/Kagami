import { Search } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { LogRow } from "@/components/log-row";
import type { StoredLog } from "@/lib/api";
import { searchLogs } from "@/lib/api";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

const LEVELS = ["", "trace", "debug", "info", "warn", "error", "fatal"];

interface SearchPageProps {
  searchParams: Promise<{
    service?: string;
    level?: string;
    since?: string;
    until?: string;
    limit?: string;
  }>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const service = params.service ?? "";
  const level = params.level ?? "";
  const since = params.since ?? "";
  const until = params.until ?? "";
  const limitStr = params.limit ?? "100";
  const limit = Math.min(Math.max(Number.parseInt(limitStr, 10) || 100, 1), 1000);

  const hasFilter = Boolean(service || level || since || until);

  // Pre-validate the date strings client-side so a typo ("yesterday")
  // surfaces a friendlier error than the API's raw `kansoku /v1/logs →
  // 400 Bad Request`. An empty string means "not set" — only flag
  // non-empty, non-parseable inputs.
  function validIso(s: string): boolean {
    return s === "" || !Number.isNaN(Date.parse(s));
  }
  const sinceInvalid = !validIso(since);
  const untilInvalid = !validIso(until);

  let logs: StoredLog[] = [];
  let error: string | undefined;
  if (sinceInvalid || untilInvalid) {
    error = `Invalid ISO timestamp: ${sinceInvalid ? "Since" : ""}${
      sinceInvalid && untilInvalid ? ", " : ""
    }${untilInvalid ? "Until" : ""}. Use e.g. 2026-05-14T00:00:00Z.`;
  } else if (hasFilter) {
    try {
      const res = await searchLogs({
        service: service || undefined,
        level: level || undefined,
        since: since || undefined,
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
          hasFilter ? (
            <span className="text-[11px] tabular-nums text-faint">
              {logs.length.toLocaleString()} result{logs.length === 1 ? "" : "s"}
            </span>
          ) : null
        }
      />

      <form method="get" className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr_120px_auto] gap-3">
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Service
            <input
              name="service"
              defaultValue={service}
              placeholder="any"
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Level
            <select
              name="level"
              defaultValue={level}
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l || "any"}
                </option>
              ))}
            </select>
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
      </form>

      {error && (
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {error}
        </div>
      )}

      {!hasFilter ? (
        <EmptyState>Set a filter and press Run.</EmptyState>
      ) : logs.length === 0 ? (
        <EmptyState>No logs matched.</EmptyState>
      ) : (
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
      )}
    </div>
  );
}
