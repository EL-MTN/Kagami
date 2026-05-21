import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader, ErrorBlock } from "@/components/shell";

// Hit when an unknown grant name is in the URL or a route doesn't exist.
// Replaces Next's default unstyled 404 so the dashboard stays inside the
// Mashiro chrome.
export default function NotFound() {
  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} /> All grants
      </Link>
      <PageHeader title="Not found" />
      <ErrorBlock
        title="No such page"
        detail="That route doesn't match a grant in the registry. Pick a grant from All grants."
      />
    </div>
  );
}
