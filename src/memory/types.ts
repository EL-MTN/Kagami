export interface VaultFile {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}
