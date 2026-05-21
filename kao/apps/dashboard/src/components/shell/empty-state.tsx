import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
}

export function EmptyState({ children }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <p className="text-sm text-faint">{children}</p>
    </div>
  );
}
