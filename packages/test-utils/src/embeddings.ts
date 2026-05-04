/**
 * Deterministic stand-in for `generateEmbedding`. Same input → same vector,
 * with enough variation across inputs that nearest-neighbor ordering reflects
 * input similarity well enough for assertions.
 *
 * Vector is hashed into 32 buckets (matches the small dim used in tests; the
 * production model emits 768/1536-dim vectors but recall logic is dim-agnostic).
 */
export function deterministicEmbedding(text: string, dim = 32): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    v[code % dim] = (v[code % dim] ?? 0) + 1;
  }
  // L2-normalize so cosine similarity behaves
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function mockEmbeddings(dim = 32): (text: string) => Promise<number[]> {
  return (text: string) => Promise.resolve(deterministicEmbedding(text, dim));
}
