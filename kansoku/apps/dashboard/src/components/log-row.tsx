import { formatTimestamp } from "@/lib/format";
import { LevelBadge } from "./level-badge";
import type { StoredLog } from "@/lib/api";

interface LogRowProps {
  log: StoredLog;
}

export function LogRow({ log }: LogRowProps) {
  return (
    <div className="grid grid-cols-[100px_70px_140px_1fr] items-baseline gap-3 border-b border-border px-3 py-2 font-mono text-[12px] tabular-nums last:border-b-0">
      <span className="text-faint" title={new Date(log.ts).toISOString()}>
        {formatTimestamp(log.ts)}
      </span>
      <LevelBadge level={log.meta.level} />
      <span
        className="truncate text-muted-foreground"
        title={`${log.meta.service} · ${log.meta.component}`}
      >
        {log.meta.service}
      </span>
      <span className="break-words text-foreground">
        {log.msg ?? <span className="text-faint">—</span>}
      </span>
    </div>
  );
}
