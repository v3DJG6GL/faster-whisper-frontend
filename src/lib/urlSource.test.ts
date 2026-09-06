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
  it("bounds the serialized output, not just the input, and is idempotent", () => {
    expect(normalizeMediaUrl("https://x.tld/" + "ä".repeat(1900))).toBeNull();
    const u = "https://x.tld/straße?q=ü";
    const once = normalizeMediaUrl(u)!;
    expect(once).not.toBeNull();
    expect(normalizeMediaUrl(once)).toBe(once);
  });
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
  it("an all-whitespace or control-only title falls back to host + path", () => {
    expect(displayLabel("https://x.tld/a", "   ")).toBe("x.tld/a");
    expect(displayLabel("https://x.tld/a", "\u0001\u0002")).toBe("x.tld/a");
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

describe("pickRung (the video ladder pick)", () => {
  const ladder = [
    { kind: "video", height: 1080, container: "mkv" },
    { kind: "video", height: 720, container: "mp4" },
    { kind: "video", height: 360, container: "mp4" },
    { kind: "audio", height: null },
  ] as import("./urlSource").VideoRung[];
  it("best when uncapped, the highest at or under a cap, the smallest when nothing fits", async () => {
    const { pickRung } = await import("./urlSource");
    expect(pickRung(ladder, null)?.height).toBe(1080);
    expect(pickRung(ladder, 720)?.height).toBe(720);
    expect(pickRung(ladder, 900)?.height).toBe(720);
    expect(pickRung(ladder, 144)?.height).toBe(360);
    expect(pickRung([{ kind: "audio", height: null }], null)).toBeNull();
    expect(pickRung(undefined, null)).toBeNull();
  });
  it("honours an explicit format id while it is on the ladder, and keeps the ladder's rank order", async () => {
    const { pickRung } = await import("./urlSource");
    const ranked = [
      { kind: "video", height: 1080, format_id: "616", note: "Premium" },
      { kind: "video", height: 1080, format_id: "399" },
      { kind: "video", height: 720, format_id: "398" },
    ] as import("./urlSource").VideoRung[];
    // Best = the first rung (the server ranks Premium above plain 1080p).
    expect(pickRung(ranked, null)?.format_id).toBe("616");
    expect(pickRung(ranked, 1080)?.format_id).toBe("616");
    expect(pickRung(ranked, null, "399")?.format_id).toBe("399");
    // A stale id falls back to the height rule.
    expect(pickRung(ranked, 720, "gone")?.format_id).toBe("398");
    // A height-less "Best available" rung is what any pick returns.
    const best = [{ kind: "video", height: null, format_id: null }] as import("./urlSource").VideoRung[];
    expect(pickRung(best, 720)).toBe(best[0]);
  });
});

describe("tierWords (D68: the seven-word scale, collapsed from the middle)", () => {
  it("never repeats a word and always keeps the ends", async () => {
    const { tierWords } = await import("./urlSource");
    expect(tierWords(1)).toEqual(["Best available"]);
    expect(tierWords(2)).toEqual(["Highest", "Lowest"]);
    expect(tierWords(3)).toEqual(["Highest", "Medium", "Lowest"]);
    expect(tierWords(4)).toEqual(["Highest", "High", "Low", "Lowest"]);
    expect(tierWords(5)).toEqual(["Highest", "High", "Medium", "Low", "Lowest"]);
    expect(tierWords(7)).toEqual(["Highest", "Very high", "High", "Medium", "Low", "Very low", "Lowest"]);
    // Past seven the tail shows facts only.
    expect(tierWords(9).slice(7)).toEqual([null, null]);
    expect(tierWords(0)).toEqual([]);
  });
});

describe("rungFacts", () => {
  it("marks estimated bitrates and sizes with ≈ and leaves exact ones bare", async () => {
    const { rungFacts } = await import("./urlSource");
    const fmt = { bytes: (n: number) => `${(n / 1e6).toFixed(0)} MB`, bitrate: (k: number) => `${(k / 1000).toFixed(1)} Mbit/s` };
    expect(rungFacts({ kind: "video", height: 1080, label: "1080p", tbr_kbps: 2190, bitrate_approx: true,
      approx_bytes: 340e6, bytes_approx: true, container: "mkv" }, fmt)).toBe("1080p · ≈2.2 Mbit/s · ≈340 MB · mkv");
    expect(rungFacts({ kind: "video", height: 1080, label: "1080p", tbr_kbps: 809, bitrate_approx: false,
      approx_bytes: 139e6, bytes_approx: false, container: "mp4" }, fmt)).toBe("1080p · 0.8 Mbit/s · 139 MB · mp4");
    expect(rungFacts({ kind: "video", height: null, label: "Best available", container: "mkv" }, fmt)).toBe("Best available · mkv");
  });
});
