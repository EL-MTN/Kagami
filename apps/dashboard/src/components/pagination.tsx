import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  basePath: string;
  searchParams?: Record<string, string>;
}

export function Pagination({
  currentPage,
  totalPages,
  basePath,
  searchParams = {},
}: PaginationProps) {
  if (totalPages <= 1) return null;

  function buildHref(page: number) {
    const params = new URLSearchParams({ ...searchParams, page: String(page) });
    return `${basePath}?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-center gap-3 pt-6">
      {currentPage > 1 ? (
        <Button variant="ghost" size="sm" asChild>
          <Link href={buildHref(currentPage - 1)} className="gap-1.5">
            <ChevronLeft className="h-3.5 w-3.5" />
            Previous
          </Link>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled className="gap-1.5">
          <ChevronLeft className="h-3.5 w-3.5" />
          Previous
        </Button>
      )}

      <span className="text-xs tabular-nums text-muted-foreground/60">
        {currentPage} of {totalPages}
      </span>

      {currentPage < totalPages ? (
        <Button variant="ghost" size="sm" asChild>
          <Link href={buildHref(currentPage + 1)} className="gap-1.5">
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled className="gap-1.5">
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
