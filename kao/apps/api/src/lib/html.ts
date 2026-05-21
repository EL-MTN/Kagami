// Shared HTML-escape for the two inline operator pages (home + OAuth callback).
// Escapes the five characters that matter for both text content and attribute
// values (single quote covers attributes delimited by single quotes; harmless
// in text). Two private copies existed before — keep them aligned via import.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
