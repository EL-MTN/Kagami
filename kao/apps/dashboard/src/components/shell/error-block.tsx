// Used when a page can't render its primary data because Kao itself is down
// or the bearer is wrong. The detail line is monospaced because it's almost
// always going to be a status code or a structured Kao error code the operator
// will paste somewhere.

interface ErrorBlockProps {
  title: string;
  detail?: string;
}

export function ErrorBlock({ title, detail }: ErrorBlockProps) {
  return (
    <div className="rounded-lg border border-[color:var(--color-critical)]/30 bg-[color:var(--color-critical)]/5 px-5 py-4">
      <p className="text-sm font-medium text-[color:var(--color-critical)]">{title}</p>
      {detail ? (
        <p className="mt-1 font-mono text-xs text-[color:var(--color-critical)]/90">{detail}</p>
      ) : null}
    </div>
  );
}
