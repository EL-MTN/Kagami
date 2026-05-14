import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  meta?: ReactNode;
}

export function PageHeader({ title, description, meta }: PageHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-3xl font-light tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {meta && <div className="shrink-0">{meta}</div>}
    </div>
  );
}
