import { describe, expect, it } from "vitest";
import {
  parseAddress,
  parseAddressList,
  parseGmailMessage,
  senderDomain,
  type GmailMessage,
} from "../src/ingest/parse-message.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

describe("parseAddress", () => {
  it('parses "Name <email@host>"', () => {
    expect(parseAddress("Sarah Connor <sarah@acme.com>")).toEqual({
      name: "Sarah Connor",
      email: "sarah@acme.com",
    });
  });
  it("parses bare email", () => {
    expect(parseAddress("sarah@acme.com")).toEqual({
      name: null,
      email: "sarah@acme.com",
    });
  });
  it("handles quoted display name", () => {
    expect(parseAddress('"Connor, Sarah" <sarah@acme.com>')).toEqual({
      name: "Connor, Sarah",
      email: "sarah@acme.com",
    });
  });
  it("lowercases the email", () => {
    expect(parseAddress("Foo <Foo@Bar.COM>")?.email).toBe("foo@bar.com");
  });
  it("returns null for unparseable", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("not an email")).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("splits comma-separated list", () => {
    const r = parseAddressList('"Connor, Sarah" <sarah@acme.com>, bob@bar.com');
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ name: "Connor, Sarah", email: "sarah@acme.com" });
    expect(r[1]).toEqual({ name: null, email: "bob@bar.com" });
  });
  it("returns empty for undefined", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("senderDomain", () => {
  it("extracts the domain", () => {
    expect(senderDomain({ name: null, email: "a@b.com" })).toBe("b.com");
    expect(senderDomain(null)).toBeNull();
  });
});

describe("parseGmailMessage", () => {
  it("parses a simple text/plain message", () => {
    const msg: GmailMessage = {
      id: "m1",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Sarah Connor <sarah@acme.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Re: Q1 review" },
          { name: "Date", value: "Thu, 15 Jan 2026 09:30:00 -0500" },
        ],
        body: { data: b64("thanks, deck attached.\n— Sarah") },
      },
    };
    const p = parseGmailMessage(msg);
    expect(p.id).toBe("m1");
    expect(p.subject).toBe("Re: Q1 review");
    expect(p.from).toEqual({ name: "Sarah Connor", email: "sarah@acme.com" });
    expect(p.to).toEqual([{ name: null, email: "me@example.com" }]);
    expect(p.bodyText).toContain("thanks, deck attached");
    expect(p.hasListUnsubscribe).toBe(false);
    expect(p.occurredAt.toISOString()).toBe("2026-01-15T14:30:00.000Z");
  });

  it("prefers text/plain in multipart", () => {
    const msg: GmailMessage = {
      id: "m2",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "s" },
        ],
        parts: [
          {
            mimeType: "text/html",
            body: { data: b64("<p>html part</p>") },
          },
          {
            mimeType: "text/plain",
            body: { data: b64("plain part") },
          },
        ],
      },
    };
    expect(parseGmailMessage(msg).bodyText).toBe("plain part");
  });

  it("falls back to stripped html when no plain part", () => {
    const msg: GmailMessage = {
      id: "m3",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "Subject", value: "s" },
        ],
        body: { data: b64("<p>hello <b>world</b></p><script>x</script>") },
      },
    };
    const p = parseGmailMessage(msg);
    expect(p.bodyText).toBe("hello world");
    expect(p.bodyText).not.toContain("<");
  });

  it("detects List-Unsubscribe", () => {
    const msg: GmailMessage = {
      id: "m4",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "newsletter@beehiiv.com" },
          { name: "Subject", value: "Weekly digest" },
          { name: "List-Unsubscribe", value: "<mailto:unsub@beehiiv.com>" },
        ],
        body: { data: b64("content") },
      },
    };
    expect(parseGmailMessage(msg).hasListUnsubscribe).toBe(true);
  });

  it("collects attachment metadata without bodies", () => {
    const msg: GmailMessage = {
      id: "m5",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "Subject", value: "s" },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64("see attached") },
          },
          {
            mimeType: "application/pdf",
            filename: "deck.pdf",
            body: { size: 123456, attachmentId: "att-1" },
          },
        ],
      },
    };
    const p = parseGmailMessage(msg);
    expect(p.attachments).toEqual([
      { name: "deck.pdf", mimeType: "application/pdf", size: 123456, ref: "att-1" },
    ]);
  });

  it("parses multiple recipients in To and Cc", () => {
    const msg: GmailMessage = {
      id: "m6",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "To", value: 'one@x.com, "Two, T" <two@x.com>' },
          { name: "Cc", value: "c@x.com" },
          { name: "Subject", value: "s" },
        ],
        body: { data: b64("") },
      },
    };
    const p = parseGmailMessage(msg);
    expect(p.to.map((a) => a.email)).toEqual(["one@x.com", "two@x.com"]);
    expect(p.cc.map((a) => a.email)).toEqual(["c@x.com"]);
  });

  it("falls back to internalDate when Date header is missing", () => {
    const ts = Date.parse("2026-01-16T06:00:00.000Z");
    const msg: GmailMessage = {
      id: "m7",
      internalDate: String(ts),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "Subject", value: "s" },
        ],
        body: { data: b64("x") },
      },
    };
    const p = parseGmailMessage(msg);
    expect(p.occurredAt.toISOString()).toBe("2026-01-16T06:00:00.000Z");
  });

  it('uses "(no subject)" when Subject header is missing', () => {
    const msg: GmailMessage = {
      id: "m8",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "From", value: "a@b.com" }],
        body: { data: b64("x") },
      },
    };
    expect(parseGmailMessage(msg).subject).toBe("(no subject)");
  });
});
