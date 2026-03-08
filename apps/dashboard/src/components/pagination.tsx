import Link from "next/link";

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
        <Link
          href={buildHref(currentPage - 1)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Previous
        </Link>
      ) : (
        <span className="rounded-md border border-border/50 px-3 py-1.5 text-sm text-muted-foreground">
          Previous
        </span>
      )}

      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>

      {currentPage < totalPages ? (
        <Link
          href={buildHref(currentPage + 1)}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Next
        </Link>
      ) : (
        <span className="rounded-md border border-border/50 px-3 py-1.5 text-sm text-muted-foreground">
          Next
        </span>
      )}
    </div>
  );
}
