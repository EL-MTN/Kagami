import Link from "next/link";
import { Calendar, Tag, FileText } from "lucide-react";
import type { Fact } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

interface FactCardProps {
  fact: Fact;
  href?: string;
  /** Compact: hide the meta footer (used in dense lists). */
  compact?: boolean;
}

export function FactCard({ fact, href, compact }: FactCardProps) {
  const linkHref = href ?? `/facts/${fact.id}`;
  return (
    <Link
      href={linkHref}
      className="group relative block rounded-lg border border-border bg-card p-4 transition-colors hover:border-rule-strong"
    >
      <p className="text-sm leading-relaxed text-foreground">{fact.text}</p>

      {!compact && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] tabular-nums text-faint">
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="h-3 w-3" strokeWidth={1.75} />
            {fact.event_date || "undated"}
          </span>
          <span className="inline-flex items-center gap-1.5 truncate">
            <FileText className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate font-mono">{fact.source_session}</span>
          </span>
          {fact.category && (
            <Badge variant="muted" className="font-normal">
              <Tag className="h-3 w-3" strokeWidth={1.75} />
              {fact.category}
            </Badge>
          )}
        </div>
      )}
    </Link>
  );
}
