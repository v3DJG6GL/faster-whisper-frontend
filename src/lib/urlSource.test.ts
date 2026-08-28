import { describe, expect, it } from "vitest";
import { displayLabel, isSourceUrl, normalizeMediaUrl, urlHost } from "./urlSource";

describe("isSourceUrl", () => {
  it("matches http(s) links, case-insensitively", () => {
    expect(isSourceUrl("https://youtube.com/watch?v=x")).toBe(true);
    expect(isSourceUrl("HTTP://example.com/a.mp3")).toBe(true);
  });
  it("never matches filesystem paths", () => {
    expect(isSourceUrl("/home/user/audio.mp3")).toBe(false);
    expect(isSourceUrl("C:\\Users\\x\\audio.mp3")).toBe(false);
    expect(isSourceUrl("relative/path.wav")).toBe(false);
    // WHATWG would parse this (single slash), but it is NOT a valid queue key.
    expect(isSourceUrl("https:/one-slash.example")).toBe(false);
  });
});

describe("normalizeMediaUrl", () => {
  it("accepts explicit-scheme links and keeps the query", () => {
    expect(normalizeMediaUrl("https://www.youtube.com/watch?v=abc&t=10")).toBe(
      "https://www.youtube.com/watch?v=abc&t=10",
    );
  });
  it("strips WHATWG noise (tabs/newlines) before judging", () => {
    expect(normalizeMediaUrl("  https://example.com/a.mp3\n")).toBe("https://example.com/a.mp3");
    expect(normalizeMediaUrl("ht\ttps://example.com/x")).toBe("https://example.com/x");
  });
  it("requires an explicit scheme — never defaults http://", () => {
    expect(normalizeMediaUrl("youtube.com/watch?v=x")).toBeNull();
    expect(normalizeMediaUrl("host:8000/audio.mp3")).toBeNull();
  });
  it("rejects single-slash schemes (the backends.ts prepend bug class)", () => {
    expect(normalizeMediaUrl("https:/evil.tld/x")).toBeNull();
  });
  it("rejects non-http schemes, empties and overlong input", () => {
    expect(normalizeMediaUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeMediaUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeMediaUrl("")).toBeNull();
    expect(normalizeMediaUrl("   ")).toBeNull();
    expect(normalizeMediaUrl("https://example.com/" + "a".repeat(2050))).toBeNull();
  });
  it("is dedupe-stable: normalizing its own output is a fixed point", () => {
    const once = normalizeMediaUrl("https://EXAMPLE.com/Path?q=1");
    expect(once).not.toBeNull();
    expect(normalizeMediaUrl(once!)).toBe(once);
  });
});

describe("displayLabel", () => {
  it("uses basename for paths", () => {
    expect(displayLabel("/a/b/talk.mp3")).toBe("talk.mp3");
    expect(displayLabel("C:\\a\\talk.mp3")).toBe("talk.mp3");
  });
  it("prefers the sanitized title for links", () => {
    expect(displayLabel("https://youtube.com/watch?v=x", "A Great Talk")).toBe("A Great Talk");
  });
  it("truncates hostile/overlong titles", () => {
    const label = displayLabel("https://x.example/", "T".repeat(500));
    expect(label.length).toBeLessThanOrEqual(121); // safeDisplayText cap + ellipsis
  });
  it("falls back to host + short path when there is no title", () => {
    expect(displayLabel("https://media.example/talks/ep1.mp3")).toBe(
      "media.example/talks/ep1.mp3",
    );
    expect(displayLabel("https://media.example/")).toBe("media.example");
  });
});

describe("urlHost", () => {
  it("extracts the hostname, empty on garbage", () => {
    expect(urlHost("https://www.youtube.com/watch?v=x")).toBe("www.youtube.com");
    expect(urlHost("not a url")).toBe("");
  });
});
