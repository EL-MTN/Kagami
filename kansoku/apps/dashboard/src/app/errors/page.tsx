import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/shell";
import { listErrors, type ErrorRecord } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

interface ErrorsPageProps {
  searchParams: Promise<{ service?: string; limit?: string }>;
}

export default async function ErrorsPage({ searchParams }: ErrorsPageProps) {
  const params = await searchParams;
  const service = params.service ?? "";
  const limit = Math.min(Math.max(Number.parseInt(params.limit ?? "100", 10) || 100, 1), 500);

  let errors: ErrorRecord[] = [];
  let fetchError: string | undefined;
  try {
    const res = await listErrors({ service: service || undefined, limit });
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
