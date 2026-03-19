export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="h-96 animate-pulse rounded-lg bg-card border border-border" />
      <div className="h-8 w-40 animate-pulse rounded bg-muted" />
      <div className="h-48 animate-pulse rounded-lg bg-card border border-border" />
    </div>
  );
}
