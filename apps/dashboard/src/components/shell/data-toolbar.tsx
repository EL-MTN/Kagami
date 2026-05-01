import type { ReactNode } from "react";

interface DataToolbarProps {
  /** Left side — typically Create / Import / Export buttons. */
  actions?: ReactNode;
  /** Right side — typically search + filter pills. */
  filters?: ReactNode;
}

export function DataToolbar({ actions, filters }: DataToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions}
      {filters && <div className="ml-auto flex flex-wrap items-center gap-2">{filters}</div>}
    </div>
  );
}
