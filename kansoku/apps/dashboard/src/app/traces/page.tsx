import Link from "next/link";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { listTraces, type TraceSummary } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

interface TracesPageProps {
  searchParams: Promise<{ service?: string; limit?: string }>;
}

export default async function TracesPage({ searchParams }: TracesPageProps) {
  const params = await searchParams;
  const service = params.service ?? "";
  const limit = Math.min(Math.max(Number.parseInt(params.limit ?? "50", 10) || 50, 1), 200);

  let traces: TraceSummary[] = [];
  let fetchError: string | undefined;
  try {
    const res = await listTraces({ service: service || undefined, limit });
    traces = res.traces;
  } catch (err) {
    fetchError = (err as Error).message;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Traces"
        description="Recent request traces across the workspace. Click a row to open its waterfall."
        meta={
          <span className="text-[11px] tabular-nums text-faint">
            {traces.length.toLocaleString()} trace{traces.length === 1 ? "" : "s"}
          </span>
        }
      />

      <form method="get" className="rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-[1fr_120px_auto] gap-3">
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
            Limit
            <input
              name="limit"
              type="number"
              min={1}
              max={200}
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
      </form>

      {fetchError && (
        <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 p-4 text-[12px] text-[color:var(--color-critical)]">
          {fetchError}
        </div>
      )}

      {traces.length === 0 && !fetchError ? (
        <EmptyState>No traces recorded yet.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {traces.map((trace) => (
            <TraceRow key={trace.traceId} summary={trace} />
          ))}
        </div>
      )}
    </div>
  );
}

function TraceRow({ summary }: { summary: TraceSummary }) {
  const idShort = summary.traceId.slice(0, 8);
  const hasErrors = summary.errorCount > 0;
  return (
    <Link
      href={`/traces/${summary.traceId}`}
      className="group flex flex-col gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-accent md:grid md:grid-cols-[1fr_140px_120px_90px_72px] md:items-baseline md:gap-4"
    >
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-[13px] text-foreground" title={summary.rootMsg}>
          {hasErrors ? (
            <AlertTriangle className="mr-1.5 -mt-0.5 inline h-3.5 w-3.5 text-[color:var(--color-critical)]" />
          ) : null}
          {summary.rootMsg || <span className="text-faint">(no message)</span>}
        </p>
        <p className="font-mono text-[10px] text-faint" title={summary.traceId}>
          {idShort}… · {summary.services.join(", ")}
        </p>
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground">
        <p>{summary.rootService}</p>
        {hasErrors ? (
          <p className="text-[color:var(--color-critical)]">
            {summary.errorCount.toLocaleString()} error{summary.errorCount === 1 ? "" : "s"}
          </p>
        ) : (
          <p className="text-faint">no errors</p>
        )}
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground md:text-right">
        <p title={formatDateTime(summary.startedAt)}>{formatRelative(summary.startedAt)}</p>
        <p className="font-mono text-faint">{summary.durationMs.toLocaleString()} ms</p>
      </div>
      <div className="font-mono text-[11px] tabular-nums text-muted-foreground md:text-right">
        <p>
          {summary.logCount.toLocaleString()} log{summary.logCount === 1 ? "" : "s"}
        </p>
        <p className="text-faint">
          {summary.spanCount.toLocaleString()} span{summary.spanCount === 1 ? "" : "s"}
        </p>
      </div>
      <div className="md:justify-self-end">
        <ArrowRight className="h-4 w-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
    </Link>
  );
}
