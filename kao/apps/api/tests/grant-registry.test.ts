import { describe, expect, it } from "vitest";
import { GRANT_NAMES, isGrantName, scopesFor } from "../src/grant-registry.js";

describe("grant-registry", () => {
  it("knows exactly the two consumer grants", () => {
    expect([...GRANT_NAMES].sort()).toEqual(["kizuna", "kokoro"]);
  });

  it("isGrantName guards unknown names", () => {
    expect(isGrantName("kizuna")).toBe(true);
    expect(isGrantName("kokoro")).toBe(true);
    expect(isGrantName("kioku")).toBe(false);
    expect(isGrantName("__proto__")).toBe(false);
    expect(isGrantName("")).toBe(false);
  });

  it("kizuna stays least-privilege: read-only, no send, no calendar write", () => {
    const s = scopesFor("kizuna");
    expect(s).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(s).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(s).not.toContain("https://www.googleapis.com/auth/gmail.send");
    expect(s).not.toContain("https://www.googleapis.com/auth/calendar");
  });

  it("kokoro carries the write scopes it needs", () => {
    const s = scopesFor("kokoro");
    expect(s).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(s).toContain("https://www.googleapis.com/auth/calendar");
  });

  it("scopesFor returns a fresh array (registry is not mutable through it)", () => {
    const a = scopesFor("kizuna");
    a.push("https://www.googleapis.com/auth/drive");
    expect(scopesFor("kizuna")).not.toContain("https://www.googleapis.com/auth/drive");
  });
});
