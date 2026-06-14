import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { ServiceSelect } from "@/components/service-select";
import { listErrors, listServiceNames, type ErrorRecord } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SortKey = "lastSeen" | "firstSeen" | "count";
const SORTS: { value: SortKey; label: string }[] = [
  { value: "count", label: "count" },
  { value: "lastSeen", label: "last seen" },
  { value: "firstSeen", label: "first seen" },
];

// Window choices in hours. `0` is the "all" sentinel — it omits `since` so the
// whole retained error history shows.
const WINDOW_OPTIONS: { hours: number; label: string }[] = [
  { hours: 1, label: "1h" },
  { hours: 6, label: "6h" },
  { hours: 24, label: "1d" },
  { hours: 24 * 7, label: "7d" },
  { hours: 0, label: "all" },
];

interface ErrorsPageProps {
  searchParams: Promise<{ service?: string; limit?: string; sort?: string; window?: string }>;
}

export default async function ErrorsPage({ searchParams }: ErrorsPageProps) {
  const params = await searchParams;
  const service = params.service ?? "";
  const limit = Math.min(Math.max(Number.parseInt(params.limit ?? "100", 10) || 100, 1), 500);
  const sort: SortKey = SORTS.some((s) => s.value === params.sort)
    ? (params.sort as SortKey)
    : "lastSeen";
  // Window in hours; `0`/unknown → "all" (no since filter).
  const windowHours = WINDOW_OPTIONS.some((w) => String(w.hours) === params.window)
    ? Number.parseInt(params.window!, 10)
    : 0;
  const since =
    windowHours > 0 ? new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString() : undefined;

  const names = await listServiceNames();

  let errors: ErrorRecord[] = [];
  let fetchError: string | undefined;
  try {
    const res = await listErrors({ service: service || undefined, limit, sort, since });
    errors = res.errors;
  } catch (err) {
    fetchError = (err as Error).message;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Errors"
        description="Distinct errors grouped by fingerprint. Click a row to inspect the most recent trace."
        meta={
          <span className="text-[11px] tabular-nums text-faint">
            {errors.length.toLocaleString()} group{errors.length === 1 ? "" : "s"}
          </span>
        }
      />

      <form method="get" className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-[1fr_140px_120px_auto] gap-3">
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Service
            <ServiceSelect name="service" defaultValue={service} services={names} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Sort
            <select
              name="sort"
              defaultValue={sort}
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] tracking-wider text-faint uppercase">
            Limit
            <input
              name="limit"
              type="number"
              min={1}
              max={500}
              defaultValue={limit}
              className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="self-end rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Filter
          </button>
        </div>

        <fieldset className="flex items-center gap-2 text-[11px] tabular-nums text-faint">
          <legend className="float-left mr-2 tracking-wider uppercase">Window</legend>
          {WINDOW_OPTIONS.map((w) => {
            const active = w.hours === windowHours;
            return (
              <label
                key={w.hours}
                className={cn(
                  "cursor-pointer rounded-md border px-2 py-0.5 font-mono transition-colors",
                  active
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name="window"
                  value={w.hours}
                  defaultChecked={active}
                  className="sr-only"
                />
                {w.label}
              </label>
            );
          })}
        </fieldset>
      </form>

      {fetchError && (
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {fetchError}
        </div>
      )}

      {errors.length === 0 && !fetchError ? (
        <EmptyState>No errors recorded yet.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {errors.map((err) => (
            <ErrorRow key={err._id} record={err} />
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorRow({ record }: { record: ErrorRecord }) {
  const latestTrace = record.recentTraceIds.at(-1);
  // Show the first 8 chars of the fingerprint with the full value in `title`.
  // The full 16-char hash overflowed narrow viewports.
  const fpShort = record._id.slice(0, 8);
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3 last:border-b-0 md:grid md:grid-cols-[1fr_140px_90px_120px_72px] md:items-baseline md:gap-4">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-[13px] text-foreground" title={record.message}>
          {record.name ? (
            <span className="text-[color:var(--color-critical)]">{record.name}: </span>
          ) : null}
          {record.message}
        </p>
        {record.sampleMsg && record.sampleMsg !== record.message ? (
          <p className="truncate text-[11px] text-muted-foreground" title={record.sampleMsg}>
            {record.sampleMsg}
          </p>
        ) : null}
        <p className="font-mono text-[10px] text-faint" title={record._id}>
          fp · {fpShort}…
        </p>
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground">
        <p>{record.service}</p>
        <p className="text-faint">{record.component}</p>
      </div>
      <div className="font-mono text-[12px] tabular-nums text-foreground md:text-right">
        × {record.count.toLocaleString()}
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground md:text-right">
        <p title={formatDateTime(record.lastSeen)}>{formatRelative(record.lastSeen)}</p>
        <p className="text-faint" title={`first seen ${formatDateTime(record.firstSeen)}`}>
          first {formatRelative(record.firstSeen)}
        </p>
      </div>
      <div className="md:justify-self-end">
        {latestTrace ? (
          <Link
            href={`/traces/${latestTrace}`}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-primary"
            title={`Trace ${latestTrace}`}
          >
            trace <ArrowRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-[10px] text-faint">—</span>
        )}
      </div>
    </div>
  );
}
