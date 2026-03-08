export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-36 animate-pulse rounded bg-muted" />
      <div className="h-10 w-96 animate-pulse rounded bg-muted" />
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg bg-card border border-border" />
        ))}
      </div>
    </div>
  );
}
