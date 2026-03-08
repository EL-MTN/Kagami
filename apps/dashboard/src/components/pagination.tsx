import Link from "next/link";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  basePath: string;
  searchParams?: Record<string, string>;
}

export function Pagination({ currentPage, totalPages, basePath, searchParams = {} }: PaginationProps) {
  if (totalPages <= 1) return null;

  function buildHref(page: number) {
    const params = new URLSearchParams({ ...searchParams, page: String(page) });
    return `${basePath}?${params.toString()}`;
  }

  return (
    <div className="flex items-center justify-center gap-2 pt-4">
      {currentPage > 1 ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={buildHref(currentPage - 1)}>Previous</Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Previous
        </Button>
      )}

      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>

      {currentPage < totalPages ? (
        <Button variant="outline" size="sm" asChild>
          <Link href={buildHref(currentPage + 1)}>Next</Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Next
        </Button>
      )}
    </div>
  );
}
