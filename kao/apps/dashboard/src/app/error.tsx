"use client";

import { useEffect } from "react";
import { PageHeader, ErrorBlock } from "@/components/shell";

// Catches render-time throws below the layout shell. Mirrors the sibling
// dashboards (Kioku has one) so an unexpected failure lands in the Mashiro
// chrome instead of Next's default unstyled overlay. notFound() / 404s are
// handled separately by not-found.tsx.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-6">
      <PageHeader title="Something went sideways" />
      <ErrorBlock title="The dashboard hit an unexpected error" detail={error.message} />
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        Try again
      </button>
    </div>
  );
}
