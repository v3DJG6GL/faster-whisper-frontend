import { describe, expect, it } from "vitest";
import { displayLabel, extractorPill, isSourceUrl, linkRefusal, linkTooLong, normalizeMediaUrl, pastesSeveralLinks, stripMediaUrlNoise, urlHost } from "./urlSource";
import { stripUrlNoise } from "./backends";

describe("linkTooLong", () => {
  it("names the server's limit when the link runs longer", () => {
    expect(linkTooLong({ duration: 18120, url_max_duration_s: 14400 })).toBe("Longer than this server's 4h limit.");
  });
  it("shows a limit that is not whole minutes exactly, never rounded past the link", () => {
    expect(linkTooLong({ duration: 100, url_max_duration_s: 90 })).toBe("Longer than this server's 1m 30s limit.");
  });
  it("is null when it fits or either number is unknown", () => {
    expect(linkTooLong({ duration: 1092, url_max_duration_s: 14400 })).toBeNull();
    expect(linkTooLong({ duration: 14400, url_max_duration_s: 14400 })).toBeNull();
    expect(linkTooLong({ duration: 18120 })).toBeNull();
    expect(linkTooLong({ duration: null, url_max_duration_s: 14400 })).toBeNull();
    expect(linkTooLong(null)).toBeNull();
  });
});

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
  it("rejects two links pasted on one line instead of merging them into one key", () => {
    expect(
      normalizeMediaUrl("https://www.youtube.com/watch?v=AAAAAAAAAAA https://www.youtube.com/watch?v=BBBBBBBBBBB"),
    ).toBeNull();
    expect(normalizeMediaUrl("https://a.tld/x.mp3 \n  http://b.tld/y.mp3")).toBeNull();
    expect(pastesSeveralLinks("https://a.tld/x https://b.tld/y")).toBe(true);
  });
  it("rejects two links from adjacent spreadsheet cells (tab-separated) but keeps a tab inside one scheme", () => {
    // An <input type=text> keeps tabs; stripUrlNoise would delete this one and glue the links together.
    expect(normalizeMediaUrl("https://a.com/x\thttps://b.com/y")).toBeNull();
    expect(pastesSeveralLinks("https://a.com/x\thttps://b.com/y")).toBe(true);
    expect(normalizeMediaUrl("ht\ttps://x.com/a")).toBe("https://x.com/a");
    expect(pastesSeveralLinks("\t https://x.com/a \t")).toBe(false);
  });
  it("says 'several links' only for a link followed by horizontal whitespace and another link (shape matrix)", () => {
    // [pasted text, several links?, normalizeMediaUrl]. Changed vs 68f08787 / HEAD, with intent:
    // edge U+00A0/U+3000/U+FEFF and text before a link no longer read as several links (the
    // hint then names the real problem); a line break inside the text is dropped first, as the
    // parsers drop it — a soft-wrapped archive link is one link again, "a ht\ntps://b" is two.
    const matrix: [string, boolean, string | null][] = [
      ["https://a/x", false, "https://a/x"],
      ["https://a/x https://b/y", true, null],
      ["https://a/x\thttps://b/y", true, null],
      ["https://a/x\u00a0https://b/y", true, null],
      // Edge U+00A0/U+3000 are trimmed as the Rust transport trims a server address (stripUrlNoise).
      ["\u00a0https://a/x", false, "https://a/x"],
      ["\u3000https://a/x", false, "https://a/x"],
      // An edge BOM or zero-width space (a web page's or chat client's copy) is dropped from a
      // media link — not from a server address (stripUrlNoise keeps U+FEFF, as Rust's trim does).
      ["\ufeffhttps://a/x", false, "https://a/x"],
      ["https://a/x\u200b", false, "https://a/x"],
      ["\u200b https://a/x\u2060\u00ad", false, "https://a/x"],
      // Separators the URL parsers keep (only CR/LF/tab are dropped) part two links.
      ["https://a/x\u2028https://b/y", true, null],
      ["https://a/x\u2029https://b/y", true, null],
      ["https://a/x\u0085https://b/y", true, null],
      ["https://a/x\vhttps://b/y", true, null],
      ["https://a/x\fhttps://b/y", true, null],
      ["https://a/x\u200bhttps://b/y", true, null],
      ["Watch this: https://youtu.be/abc", false, null],
      ["https://web.archive.org/web/2020/https://h/v.mp4", false, "https://web.archive.org/web/2020/https://h/v.mp4"],
      ["https://web.archive.org/web/2020/\nhttps://h/v.mp4", false, "https://web.archive.org/web/2020/https://h/v.mp4"],
      ["  https://a/x  ", false, "https://a/x"],
      ["https://a/x ht\ntps://b/y", true, null],
      ["youtu.be/abc", false, null],
      ["", false, null],
      ["https://a.tld/x.mp3 \n  http://b.tld/y.mp3", true, null],
    ];
    for (const [raw, several, url] of matrix) {
      expect([raw, pastesSeveralLinks(raw)]).toEqual([raw, several]);
      expect([raw, normalizeMediaUrl(raw)]).toEqual([raw, url]);
    }
  });
  it("drops an invisible zero-width space or BOM at a media link's edges, not a server address's", () => {
    expect(normalizeMediaUrl("https://youtu.be/abc\u200b")).toBe("https://youtu.be/abc");
    expect(normalizeMediaUrl("\ufeffhttps://youtu.be/abc")).toBe("https://youtu.be/abc");
    expect(pastesSeveralLinks("https://youtu.be/abc\u200b")).toBe(false);
    expect(stripMediaUrlNoise("\u200bhttps://youtu.be/abc\ufeff")).toBe("https://youtu.be/abc");
    // Inside the link nothing is touched.
    expect(stripMediaUrlNoise("https://a/x\u200by")).toBe("https://a/x\u200by");
    expect(stripUrlNoise("\ufeffhttp://srv:8000")).toBe("\ufeffhttp://srv:8000");
  });
  it("hears two links parted by a line/paragraph separator or a zero-width space", () => {
    expect(pastesSeveralLinks("https://a.com/x\u2028https://b.com/y")).toBe(true);
    expect(pastesSeveralLinks("https://a.com/x\u200bhttps://b.com/y")).toBe(true);
    expect(normalizeMediaUrl("https://a.com/x\u2029https://b.com/y")).toBeNull();
  });
  it("keeps a link with an embedded scheme and a path with a space", () => {
    const archived = "https://web.archive.org/web/2020/https://example.com/v.mp4";
    expect(normalizeMediaUrl(archived)).toBe(archived);
    expect(normalizeMediaUrl("https://host/My File.mp3")).toBe("https://host/My%20File.mp3");
    expect(pastesSeveralLinks(archived)).toBe(false);
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

describe("extractorPill", () => {
  it("reads Generic as a direct link and keeps a real site name", () => {
    expect(extractorPill("Generic")).toBe("direct link");
    expect(extractorPill("Youtube")).toBe("Youtube");
  });

  it("is empty for a name with nothing visible left, so no pill is drawn", () => {
    expect(extractorPill("\u200b\u202e")).toBe("");
    expect(extractorPill("  ")).toBe("");
    expect(extractorPill(undefined)).toBe("");
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
    // Past seven the rungs above the last show facts only: "Lowest" stays on the last rung.
    expect(tierWords(8)).toEqual(["Highest", "Very high", "High", "Medium", "Low", "Very low", null, "Lowest"]);
    expect(tierWords(9).slice(6)).toEqual([null, null, "Lowest"]);
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

describe("linkRefusal", () => {
  it("reads a server link-policy refusal as a sentence", () => {
    expect(linkRefusal("link_refused:this media runs 5.0 h — over the server's 4.0 h limit for link downloads")).toBe(
      "This media runs 5.0 h — over the server's 4.0 h limit for link downloads.",
    );
    expect(linkRefusal("link_refused:playlists aren't supported — link a single video or track")).toBe(
      "Playlists aren't supported — link a single video or track.",
    );
  });

  it("leaves every other preview failure to the run", () => {
    expect(linkRefusal("HTTP 400: the site took too long to answer")).toBeNull();
    expect(linkRefusal("link_refused:   ")).toBeNull();
    expect(linkRefusal(undefined)).toBeNull();
  });
});
