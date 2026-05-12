// Set-overlap citation recall: |predicted ∩ truth| / |truth|. Matches
// LongMemEval's session-level recall definition (Wu et al., 2024).
// Returns undefined when ground truth is missing or empty so the mean
// is computed only over items where the metric is defined. Lives in
// its own file so the test suite can import it without triggering the
// orchestrator's top-level main() call in longmemeval.ts.
export function computeCitationRecall(
  citations: string[],
  truth: string[] | undefined,
): number | undefined {
  if (!truth || truth.length === 0) return undefined;
  const cited = new Set(citations);
  let hit = 0;
  for (const t of truth) {
    if (cited.has(t)) hit += 1;
  }
  return hit / truth.length;
}
