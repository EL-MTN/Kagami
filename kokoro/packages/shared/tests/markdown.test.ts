import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/markdown";

describe("parseMarkdown", () => {
  it("returns empty frontmatter and trimmed content when no frontmatter is present", () => {
    const result = parseMarkdown("\n# hello\n\nworld\n\n");
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe("# hello\n\nworld");
  });

  it("parses YAML frontmatter into the frontmatter field", () => {
    const raw = [
      "---",
      "name: Mashiro",
      "voice: warm",
      "tags:",
      "  - one",
      "  - two",
      "---",
      "",
      "Body.",
    ].join("\n");
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({
      name: "Mashiro",
      voice: "warm",
      tags: ["one", "two"],
    });
    expect(result.content).toBe("Body.");
  });

  it("trims surrounding whitespace from content but preserves internal newlines", () => {
    const raw = "---\nname: x\n---\n\n\nline one\n\nline two\n\n\n";
    const result = parseMarkdown(raw);
    expect(result.content).toBe("line one\n\nline two");
  });

  it("returns an empty content string when only frontmatter is present", () => {
    const raw = "---\nname: x\n---\n";
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({ name: "x" });
    expect(result.content).toBe("");
  });

  it("treats non-string scalar values in frontmatter according to YAML semantics", () => {
    const raw = "---\nenabled: true\ncount: 42\nrate: 3.14\n---\n\nbody";
    const result = parseMarkdown(raw);
    expect(result.frontmatter).toEqual({ enabled: true, count: 42, rate: 3.14 });
  });
});
