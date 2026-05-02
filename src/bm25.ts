// In-memory BM25 over lemmatized text. Standard Okapi BM25 (k1=1.5,
// b=0.75 — the rank_bm25 library defaults that mem0 inherits).
// At our scale (~5K facts/vault) building the index per query is fast.

const K1 = 1.5;
const B = 0.75;

export interface Bm25Document {
  id: string;
  lemmatized: string;
}

export interface Bm25Score {
  id: string;
  score: number;
}

interface IndexedDoc {
  id: string;
  termFreqs: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private docs: IndexedDoc[] = [];
  private docFreq: Map<string, number> = new Map();
  private avgDocLength = 0;
  private numDocs = 0;

  constructor(documents: Bm25Document[]) {
    for (const doc of documents) {
      const tokens = tokenize(doc.lemmatized);
      const termFreqs = new Map<string, number>();
      for (const tok of tokens) {
        termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + 1);
      }
      this.docs.push({ id: doc.id, termFreqs, length: tokens.length });
      for (const term of termFreqs.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.numDocs = this.docs.length;
    const totalLength = this.docs.reduce((s, d) => s + d.length, 0);
    this.avgDocLength = this.numDocs > 0 ? totalLength / this.numDocs : 0;
  }

  // Standard Okapi BM25.
  // idf(t)   = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
  // score(d) = Σ_t idf(t) * tf(t,d)*(k1+1) / (tf(t,d) + k1*(1 - b + b*|d|/avgdl))
  query(queryLemmatized: string): Bm25Score[] {
    const queryTokens = tokenize(queryLemmatized);
    if (queryTokens.length === 0 || this.numDocs === 0) return [];

    const idf = new Map<string, number>();
    for (const term of queryTokens) {
      if (idf.has(term)) continue;
      const df = this.docFreq.get(term) ?? 0;
      const v = Math.log((this.numDocs - df + 0.5) / (df + 0.5) + 1);
      idf.set(term, v);
    }

    const out: Bm25Score[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;
        const termIdf = idf.get(term) ?? 0;
        const denom =
          tf + K1 * (1 - B + (B * doc.length) / (this.avgDocLength || 1));
        score += termIdf * ((tf * (K1 + 1)) / denom);
      }
      if (score > 0) out.push({ id: doc.id, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
}

function tokenize(s: string): string[] {
  if (!s) return [];
  return s.split(/\s+/).filter((t) => t.length > 0);
}
