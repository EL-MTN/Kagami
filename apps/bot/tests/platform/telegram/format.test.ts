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
      expect(markdownToTelegramHtml("hello **world** end")).toBe(
        "hello <b>world</b> end",
      );
    });

    it("converts italic *x*", () => {
      expect(markdownToTelegramHtml("a *b* c")).toBe("a <i>b</i> c");
    });

    it("does not treat ** as italic (bold takes precedence)", () => {
      expect(markdownToTelegramHtml("**bold** *italic*")).toBe(
        "<b>bold</b> <i>italic</i>",
      );
    });

    it("converts inline code with backticks", () => {
      expect(markdownToTelegramHtml("see `foo` here")).toBe(
        "see <code>foo</code> here",
      );
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
