export interface VaultFile {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface SearchResult {
  path: string;
  matches: string[];
  score: number;
}
