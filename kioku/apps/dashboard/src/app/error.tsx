"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <div className="rounded-lg border border-critical/20 bg-critical/5 p-8">
      <div className="flex items-start gap-4">
        <div className="rounded-md bg-critical/10 p-2 text-critical">
          <AlertTriangle className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="flex-1">
          <h2 className="font-display text-xl text-foreground">Something went sideways.</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The Kioku API may not be reachable. Confirm the server is running on{" "}
            <code className="font-mono text-foreground">127.0.0.1:7777</code> and that MongoDB is
            up.
          </p>
          <p className="mt-3 font-mono text-[11px] text-faint">{error.message}</p>
          <Button onClick={reset} variant="outline" size="sm" className="mt-4">
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
