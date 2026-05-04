import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned slot for status counts, action buttons, etc. */
  meta?: ReactNode;
}

export function PageHeader({ title, description, meta }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-3xl text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {meta && <div className="shrink-0">{meta}</div>}
    </div>
  );
}
