import { cn } from "@/lib/utils";
import { levelTone } from "@/lib/format";

interface LevelBadgeProps {
  level: string;
  className?: string;
}

const toneClass: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-[color:var(--color-primary)]/10 text-[color:var(--color-primary)] border-[color:var(--color-primary)]/30",
  positive:
    "bg-[color:var(--color-positive)]/10 text-[color:var(--color-positive)] border-[color:var(--color-positive)]/30",
  caution:
    "bg-[color:var(--color-caution)]/10 text-[color:var(--color-caution)] border-[color:var(--color-caution)]/30",
  critical:
    "bg-[color:var(--color-critical)]/10 text-[color:var(--color-critical)] border-[color:var(--color-critical)]/30",
};

export function LevelBadge({ level, className }: LevelBadgeProps) {
  const tone = levelTone(level);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        toneClass[tone] ?? toneClass.neutral,
        className,
      )}
    >
      {level}
    </span>
  );
}
