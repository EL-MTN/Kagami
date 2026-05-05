/**
 * Convert common Markdown patterns to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a href="">, <blockquote>
 *
 * This is intentionally lightweight — handles the patterns LLMs commonly produce
 * without pulling in a full Markdown parser.
 */
export function markdownToTelegramHtml(text: string): string {
  let result = text;

  // 1. Escape HTML entities first (before we insert any tags)
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 2. Code blocks (``` ... ```) → <pre>
  result = result.replace(
    /```[\w]*\n?([\s\S]*?)```/g,
    (_, code: string) => `<pre>${code.trim()}</pre>`,
  );

  // 3. Inline code (` ... `) → <code>
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // 4. Bold (**text**) → <b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic (*text*) — only single asterisks not already consumed by bold
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // 6. Strikethrough (~~text~~) → <s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Links [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
}
