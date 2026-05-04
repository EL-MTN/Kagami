import type { ReactNode } from 'react';

interface EmptyStateProps {
  children: ReactNode;
  /** "inline" inside a card with no border; "card" stands alone with dashed border. */
  variant?: 'card' | 'inline';
}

export function EmptyState({ children, variant = 'card' }: EmptyStateProps) {
  if (variant === 'inline') {
    return <p className="py-12 text-center text-sm text-faint">{children}</p>;
  }
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <p className="text-sm text-faint">{children}</p>
    </div>
  );
}
