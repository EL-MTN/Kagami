"use client";

import { useState, useTransition } from "react";
import { revokeGrantAction } from "@/app/actions";
import { cn } from "@/lib/utils";

interface RevokeButtonProps {
  grant: string;
  granted: boolean;
}

// Two-step inline confirmation, no modal. The "Revoke" button flips to
// "Confirm" + "Cancel" so a fat-thumb click can't drop a grant. The action
// runs in a transition so the button can show a pending state without React
// freezing the rest of the page.
export function RevokeButton({ grant, granted }: RevokeButtonProps) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  if (!granted) {
    return (
      <button
        type="button"
        disabled
        className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-faint"
        title="Nothing to revoke — grant is not connected"
      >
        Revoke
      </button>
    );
  }

  if (!confirming) {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-[color:var(--color-critical)]/40 hover:text-[color:var(--color-critical)]"
        >
          Revoke
        </button>
        {error && (
          <span className="text-[10px] text-[color:var(--color-critical)]">
            Couldn&rsquo;t revoke ({error.code}): {error.message}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-[color:var(--color-critical)]">Revoke {grant}?</span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await revokeGrantAction(grant);
            if (res.ok) {
              setError(null);
              setConfirming(false);
            } else {
              // Surface the structured failure inline and drop back out of the
              // confirming state so the operator can read the message and
              // decide whether to retry.
              setError({ code: res.code, message: res.message });
              setConfirming(false);
            }
          })
        }
        className={cn(
          "rounded-md border border-[color:var(--color-critical)] bg-[color:var(--color-critical)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-critical-foreground)] transition-opacity",
          pending && "opacity-60",
        )}
      >
        {pending ? "Revoking…" : "Confirm"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirming(false)}
        className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        Cancel
      </button>
    </span>
  );
}
