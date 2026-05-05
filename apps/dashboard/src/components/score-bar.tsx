interface ScoreBarProps {
  /** Final fused score from the ranker, in [0, 1]. */
  score?: number;
  /** Cosine similarity component, in [0, 1]. */
  semantic?: number;
  /** BM25 component, normalized to [0, 1]. */
  bm25?: number;
  /** Entity-boost component, in [0, 0.5]. */
  entityBoost?: number;
  className?: string;
}

/**
 * Score-fusion visualization. Kioku's ranker fuses three signals additively:
 *   (semantic + bm25 + entity_boost) / max_possible
 * This bar renders each contribution as a stacked horizontal segment, sized
 * by its raw weight in the fused total. Hovering a segment reveals its name
 * and value; the trailing badge shows the final score in tabular mono.
 */
export function ScoreBar({ score, semantic, bm25, entityBoost, className }: ScoreBarProps) {
  const sem = semantic ?? 0;
  const lex = bm25 ?? 0;
  const ent = entityBoost ?? 0;
  const sum = sem + lex + ent;

  // Each segment's pixel width is proportional to its raw contribution.
  // If no breakdown is available, fall back to a single foreground bar.
  const hasBreakdown = sum > 0;
  const hasScore = score !== undefined;
  const segW = (v: number) => (hasBreakdown ? `${(v / sum) * 100}%` : "0%");
  const fillW = hasScore ? `${Math.min(1, score) * 100}%` : "100%";

  if (!hasBreakdown && !hasScore) {
    return (
      <div className={className}>
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-muted" />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
            —
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-3">
        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
          {hasBreakdown ? (
            <div className="absolute inset-y-0 left-0 flex h-full" style={{ width: fillW }}>
              {sem > 0 && (
                <span
                  title={`semantic ${sem.toFixed(3)}`}
                  className="score-segment h-full"
                  style={{
                    width: segW(sem),
                    backgroundColor: "var(--color-channel-semantic)",
                    animationDelay: "0ms",
                  }}
                />
              )}
              {lex > 0 && (
                <span
                  title={`bm25 ${lex.toFixed(3)}`}
                  className="score-segment h-full"
                  style={{
                    width: segW(lex),
                    backgroundColor: "var(--color-channel-bm25)",
                    animationDelay: "120ms",
                  }}
                />
              )}
              {ent > 0 && (
                <span
                  title={`entity ${ent.toFixed(3)}`}
                  className="score-segment h-full"
                  style={{
                    width: segW(ent),
                    backgroundColor: "var(--color-channel-entity)",
                    animationDelay: "240ms",
                  }}
                />
              )}
            </div>
          ) : (
            <div
              className="score-segment absolute inset-y-0 left-0 h-full bg-foreground/40"
              style={{ width: fillW }}
            />
          )}
        </div>
        <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-foreground">
          {score !== undefined ? score.toFixed(3) : "—"}
        </span>
      </div>

      {hasBreakdown && (
        <div className="mt-1.5 flex items-center gap-3 text-[10px] tabular-nums text-faint">
          {sem > 0 && (
            <span className="inline-flex items-center gap-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: "var(--color-channel-semantic)" }}
              />
              sem {sem.toFixed(2)}
            </span>
          )}
          {lex > 0 && (
            <span className="inline-flex items-center gap-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: "var(--color-channel-bm25)" }}
              />
              bm25 {lex.toFixed(2)}
            </span>
          )}
          {ent > 0 && (
            <span className="inline-flex items-center gap-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: "var(--color-channel-entity)" }}
              />
              ent {ent.toFixed(2)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ScoreLegend() {
  const items: { label: string; key: string; color: string }[] = [
    { label: "semantic", key: "semantic", color: "var(--color-channel-semantic)" },
    { label: "bm25", key: "bm25", color: "var(--color-channel-bm25)" },
    { label: "entity", key: "entity", color: "var(--color-channel-entity)" },
  ];
  return (
    <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.key} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
