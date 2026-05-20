import type { GrantStatus } from "@/lib/api";

// Three states map directly onto the workspace palette: positive (granted),
// caution (never granted — operator action needed), critical (revoked —
// previously trusted, now actively withdrawn). Keep the visual difference
// between "not yet" and "no more" sharp so an operator doesn't mistake one
// for the other.
type Tone = "positive" | "caution" | "critical";

function tone(g: GrantStatus): { label: string; tone: Tone } {
  if (g.granted) return { label: "granted", tone: "positive" };
  if (g.revokedAt) return { label: "revoked", tone: "critical" };
  return { label: "not granted", tone: "caution" };
}

const toneClass: Record<Tone, string> = {
  positive: "bg-[color:var(--color-positive)]/10 text-[color:var(--color-positive)]",
  caution: "bg-[color:var(--color-caution)]/15 text-[color:var(--color-caution-foreground)]",
  critical: "bg-[color:var(--color-critical)]/10 text-[color:var(--color-critical)]",
};

const dotClass: Record<Tone, string> = {
  positive: "bg-[color:var(--color-positive)]",
  caution: "bg-[color:var(--color-caution)]",
  critical: "bg-[color:var(--color-critical)]",
};

export function GrantBadge({ grant }: { grant: GrantStatus }) {
  const { label, tone: t } = tone(grant);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClass[t]}`}
    >
      <span className={`h-1 w-1 rounded-full ${dotClass[t]}`} aria-hidden />
      {label}
    </span>
  );
}
