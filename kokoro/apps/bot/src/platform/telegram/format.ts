/**
 * Convert common Markdown patterns to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <s>, <u>, <code>, <pre>, <a href="">, <blockquote>
 *
 * This is intentionally lightweight — handles the patterns LLMs commonly produce
 * without pulling in a full Markdown parser.
 */
export function markdownToTelegramHtml(text: string): string {
  // 0. Strip NUL bytes — Telegram rejects them anyway, and the placeholder
  //    scheme below uses NUL as its sentinel, so none may come from input.
  // eslint-disable-next-line no-control-regex
  let result = text.replace(/\u0000/g, "");

  // 1. Escape HTML entities first (before we insert any tags)
  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code contents must render VERBATIM: the inline passes below (bold/italic/
  // links/…) must never rewrite what's inside a fence or backticks — the
  // executeCode approval bubble shows a fenced program, and what the user
  // reviews has to be exactly what executes. So code segments are parked as
  // NUL-delimited placeholders and restored after every inline pass ran.
  const parked: string[] = [];
  const park = (html: string): string => `\u0000${parked.push(html) - 1}\u0000`;

  // 2. Code blocks (``` ... ```) → <pre>. Fences are 3+ backticks with a
  //    matching-length closer (backreference) — the executeCode prompt uses
  //    a fence longer than any backtick run in the code, so an embedded ```
  //    can't close the block early. Strip ONLY the wrapper newline before
  //    the closing fence — never trim the body: leading indentation and
  //    trailing whitespace are part of the program (an indented first line
  //    trimmed for display would show code that differs from what an
  //    executeCode approval actually runs).
  result = result.replace(
    /(`{3,})(\w*)\n?([\s\S]*?)\1/g,
    (_, _fence: string, _lang: string, code: string) =>
      park(`<pre>${code.replace(/\n$/, "")}</pre>`),
  );

  // 3. Inline code (` ... `) → <code>
  result = result.replace(/`([^`\n]+)`/g, (_, code: string) => park(`<code>${code}</code>`));

  // 4. Bold (**text**) → <b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic (*text*) — only single asterisks not already consumed by bold
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // 6. Strikethrough (~~text~~) → <s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Links [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 8. Restore parked code segments untouched.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\u0000(\d+)\u0000/g, (_, i: string) => parked[Number(i)] ?? "");

  return result;
}
