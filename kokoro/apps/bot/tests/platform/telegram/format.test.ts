import { describe, expect, it } from "vitest";

import { markdownToTelegramHtml } from "../../../src/platform/telegram/format";

describe("markdownToTelegramHtml", () => {
  describe("HTML escaping", () => {
    it("escapes raw &, <, > before any markdown processing", () => {
      expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    });

    it("preserves escaping inside markdown bodies (HTML escape happens first)", () => {
      // The input is `**<script>**`. Escaping turns < and > into entities,
      // then the bold rule wraps the result.
      expect(markdownToTelegramHtml("**<script>**")).toBe("<b>&lt;script&gt;</b>");
    });
  });

  describe("inline formatting", () => {
    it("converts bold **x**", () => {
      expect(markdownToTelegramHtml("hello **world** end")).toBe("hello <b>world</b> end");
    });

    it("converts italic *x*", () => {
      expect(markdownToTelegramHtml("a *b* c")).toBe("a <i>b</i> c");
    });

    it("does not treat ** as italic (bold takes precedence)", () => {
      expect(markdownToTelegramHtml("**bold** *italic*")).toBe("<b>bold</b> <i>italic</i>");
    });

    it("converts inline code with backticks", () => {
      expect(markdownToTelegramHtml("see `foo` here")).toBe("see <code>foo</code> here");
    });

    it("converts strikethrough ~~x~~", () => {
      expect(markdownToTelegramHtml("a ~~no~~ b")).toBe("a <s>no</s> b");
    });

    it("converts inline links [text](url)", () => {
      expect(markdownToTelegramHtml("see [docs](https://example.com)")).toBe(
        'see <a href="https://example.com">docs</a>',
      );
    });
  });

  describe("code blocks", () => {
    it("converts fenced code blocks to <pre>", () => {
      const out = markdownToTelegramHtml("```\nlet x = 1;\n```");
      expect(out).toBe("<pre>let x = 1;</pre>");
    });

    it("strips the language label after the opening fence", () => {
      const out = markdownToTelegramHtml("```ts\nconst y = 2;\n```");
      expect(out).toBe("<pre>const y = 2;</pre>");
    });

    it("handles multi-line code blocks", () => {
      const out = markdownToTelegramHtml("```\nline1\nline2\n```");
      expect(out).toBe("<pre>line1\nline2</pre>");
    });
  });

  describe("code renders verbatim (parked from inline passes)", () => {
    // The executeCode approval bubble shows a fenced program — what the user
    // reviews must be byte-for-byte what executes, so markdown-looking text
    // inside code must never be rewritten by the inline passes.
    it("does not bold/italicize markdown-looking code inside a fence", () => {
      const out = markdownToTelegramHtml("```python\nprint('**bold**', 2 * 3 * 4)\n```");
      expect(out).toBe("<pre>print('**bold**', 2 * 3 * 4)</pre>");
    });

    it("does not linkify subscript-call patterns like x[0](y) inside a fence", () => {
      const out = markdownToTelegramHtml("```js\nconst v = fns[0](arg);\n```");
      expect(out).toBe("<pre>const v = fns[0](arg);</pre>");
    });

    it("preserves backticks and strikethrough-looking text inside a fence", () => {
      const out = markdownToTelegramHtml("```\nrun `cmd` with ~~care~~\n```");
      expect(out).toBe("<pre>run `cmd` with ~~care~~</pre>");
    });

    it("does not reinterpret markdown inside inline code", () => {
      expect(markdownToTelegramHtml("see `a * b * c` and `[x](y)` here")).toBe(
        "see <code>a * b * c</code> and <code>[x](y)</code> here",
      );
    });

    it("strips NUL bytes from input so they cannot forge placeholders", () => {
      expect(markdownToTelegramHtml("a\u00000\u0000b and `code`")).toBe(
        "a0b and <code>code</code>",
      );
    });
  });

  describe("composition", () => {
    it("handles multiple constructs in one string", () => {
      const input = "I **bolded** a *word* and added `code` plus a [link](https://x.com).";
      expect(markdownToTelegramHtml(input)).toBe(
        'I <b>bolded</b> a <i>word</i> and added <code>code</code> plus a <a href="https://x.com">link</a>.',
      );
    });

    it("returns plain text unchanged when no markdown present", () => {
      expect(markdownToTelegramHtml("just plain text")).toBe("just plain text");
    });
  });
});
