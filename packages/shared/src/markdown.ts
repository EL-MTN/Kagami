import matter from "gray-matter";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  content: string;
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const { data, content } = matter(raw);
  return { frontmatter: data, content: content.trim() };
}
