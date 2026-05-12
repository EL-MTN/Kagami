// Set-overlap citation recall: |predicted ∩ truth| / |truth|. Matches
// LongMemEval's session-level recall definition (Wu et al., 2024).
// Both inputs must be in the same id space — for the LongMemEval
// bench that's bare session ids (no `raw/` prefix), which is what
// `extractCitations` already emits. Returns undefined when ground
// truth is missing or empty so the mean is computed only over items
// where the metric is defined. Lives in its own file so the test
// suite can import it without triggering the orchestrator's top-level
// main() call in longmemeval.ts.
export function computeCitationRecall(
  citations: string[],
  truth: string[] | undefined,
): number | undefined {
  if (!truth || truth.length === 0) return undefined;
  // Dedupe truth so a dataset that lists the same evidence session
  // twice doesn't inflate the denominator and deflate recall. The
  // dataset contract is supposed to guarantee uniqueness, but the
  // metric is cheap to make self-defensive.
  const truthSet = new Set(truth);
  const cited = new Set(citations);
  let hit = 0;
  for (const t of truthSet) {
    if (cited.has(t)) hit += 1;
  }
  return hit / truthSet.size;
}
