// A synced audio/log folder change (the "Audio folder" / "Log folder" switches) moves where every
// later recording, audio copy or session log is written — on Windows a UNC path sends them to a
// network host. An unattended pull holds such a move for the security review, like a repointed
// server; a move back to the default, an unchanged value and a gated-off path never prompt.

import { describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  categorySelection,
  consentDetailCap,
  consentDetailText,
  consentDetailTitle,
  folderPathText,
  getPendingReview,
  pullNow,
  pushNow,
  resetSyncState,
  resolvedFolderPath,
  securityChanges,
} from "./sync";
import { safeIdentityText } from "../sanitize";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { DEFAULT_SETTING_SYNC } from "../settingsManifest";
import { backend } from "./syncTestFixtures";
import type { SyncBlob } from "./syncTypes";

const api = vi.hoisted(() => ({ pushed: null as unknown, pull: null as unknown }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async () => ({ b1: "sk" }),
  readBackendKeyStates: async () => ({ keys: { b1: "sk" }, unreadable: [] }),
  setBackendKey: async () => {},
  deleteBackendKey: async () => {},
  syncPush: async (args: { blob: unknown; baseVersion: number }) => {
    api.pushed = args.blob;
    const v = args.baseVersion + 1;
    return { ok: true, status: 200, state: { version: v, updated_ts: v, device: "me", blob: {} } };
  },
  syncPull: async () => ({ ok: true, status: 200, state: api.pull }),
}));

const CATS = categorySelection(true);
const UNC = "\\\\attacker.example\\share\\audio";

describe("securityChanges: folder moves", () => {
  const rows = (incoming: unknown, local: unknown, gates?: object) =>
    securityChanges(incoming as never, local as never, CATS, gates as never)
      .filter((c) => c.kind === "audio-folder" || c.kind === "log-folder")
      .map((c) => [c.kind, c.detail]);

  it("raises a row for a differing non-blank path with the switch on", () => {
    const on = { audioFolder: true, logFolder: true };
    expect(rows({ recording: { audioBaseDir: UNC } }, { recording: { audioBaseDir: null } }, on)).toEqual([
      ["audio-folder", UNC],
    ]);
    expect(rows({ recording: { recordingsDir: "C:\\rec" } }, { recording: { recordingsDir: "D:\\rec" } }, on)).toEqual([
      ["audio-folder", "C:\\rec"],
    ]);
    expect(rows({ logging: { logDir: "//host/logs" } }, { logging: { logDir: "/var/log/me" } }, on)).toEqual([
      ["log-folder", "//host/logs"],
    ]);
    // Both audio fields moving to the same place is one row.
    expect(
      rows({ recording: { audioBaseDir: UNC, recordingsDir: UNC } }, { recording: {} }, on),
    ).toEqual([["audio-folder", UNC]]);
  });

  it("raises nothing for a gated-off, unchanged or back-to-default path", () => {
    const on = { audioFolder: true, logFolder: true };
    expect(rows({ recording: { audioBaseDir: UNC } }, { recording: {} }, { audioFolder: false })).toEqual([]);
    expect(rows({ logging: { logDir: UNC } }, { logging: {} }, { logFolder: false })).toEqual([]);
    // Unchanged (whitespace aside).
    expect(rows({ recording: { audioBaseDir: " /a " } }, { recording: { audioBaseDir: "/a" } }, on)).toEqual([]);
    // Back to the default location.
    expect(rows({ recording: { audioBaseDir: null } }, { recording: { audioBaseDir: "/a" } }, on)).toEqual([]);
    expect(rows({ logging: { logDir: "  " } }, { logging: { logDir: "/a" } }, on)).toEqual([]);
    // The category itself not synced.
    expect(
      securityChanges({ recording: { audioBaseDir: UNC } } as never, { recording: {} } as never, {
        ...CATS,
        recording: false,
      }, on as never),
    ).toEqual([]);
  });
  it("compares by the trim Rust opens with, so a U+FEFF edge raises a row", () => {
    const on = { audioFolder: true, logFolder: true };
    // JS `trim` strips U+FEFF, Rust `str::trim` does not: the peer's path opens a lookalike folder.
    expect(rows({ recording: { audioBaseDir: "/home/u/rec\ufeff" } }, { recording: { audioBaseDir: "/home/u/rec" } }, on)).toEqual([
      ["audio-folder", "/home/u/rec\ufeff"],
    ]);
    expect(rows({ recording: { recordingsDir: "\ufeff/home/u/rec" } }, { recording: { recordingsDir: "/home/u/rec" } }, on)).toEqual([
      ["audio-folder", "\ufeff/home/u/rec"],
    ]);
    expect(rows({ logging: { logDir: "/var/log/me\ufeff" } }, { logging: { logDir: "/var/log/me" } }, on)).toEqual([
      ["log-folder", "/var/log/me\ufeff"],
    ]);
    // Edges both trims strip, and U+0085 (Rust only), still open the same folder: no row.
    expect(rows({ logging: { logDir: "\u0085/var/log/me\u3000" } }, { logging: { logDir: "/var/log/me" } }, on)).toEqual([]);
  });
  it("the row shows a long padded path whole, destination included", () => {
    // Visible padding a head-kept 200 cut would leave in front of the "…".
    const padded = "\\\\fileserver.corp.example.com." + "x.".repeat(120) + "evil.tld\\share\\" + "./".repeat(200) + "rec";
    const [row] = securityChanges(
      { recording: { audioBaseDir: padded } } as never,
      { recording: {} } as never,
      CATS,
      { audioFolder: true } as never,
    );
    const shown = safeIdentityText(row.detail, consentDetailCap(row.kind));
    expect(shown).toBe(padded);
    // Its `./` runs resolve away: the row shows the share folder Windows opens.
    expect(consentDetailText(row)).toBe("\\\\fileserver.corp.example.com." + "x.".repeat(120) + "evil.tld\\share\\rec");
    expect(consentDetailCap("log-folder")).toBe(consentDetailCap("audio-folder"));
  });
  it("a path past the cap shows its head and its destination's end", () => {
    // A long path with nothing to resolve: a head-kept cut would leave its end behind the "…".
    const long = "C:\\Users\\me\\" + "ab\\".repeat(1500) + "Users\\Public\\x";
    const [row] = securityChanges(
      { recording: { audioBaseDir: long } } as never,
      { recording: {} } as never,
      CATS,
      { audioFolder: true } as never,
    );
    const shown = consentDetailText(row);
    expect(shown.startsWith("C:\\Users\\me\\ab\\")).toBe(true);
    expect(shown.endsWith("ab\\Users\\Public\\x")).toBe(true);
    expect(shown).toContain(" … ");
    expect([...shown].length).toBeLessThanOrEqual(4096 + 3);
    expect(consentDetailTitle(row)).toBeUndefined();
    // The same holds for a log folder; an exact-cap path still renders whole.
    expect(consentDetailText({ kind: "log-folder", detail: long })).toBe(shown);
    const fits = "C:\\" + "a".repeat(4093);
    expect(consentDetailText({ kind: "audio-folder", detail: fits })).toBe(fits);
  });
  it("a path whose `..` hides between padding walls shows the folder it really opens", () => {
    // Head and tail are both `.\` walls; the `..` components that move the destination sit in
    // the middle a head+tail cut leaves out. Windows resolves them before opening the folder.
    const both = "C:\\Users\\me\\Recordings\\" + ".\\".repeat(1100) + "..\\..\\..\\Public\\" + ".\\".repeat(1100) + "Users\\me\\Recordings";
    const [row] = securityChanges(
      { recording: { audioBaseDir: both } } as never,
      { recording: {} } as never,
      CATS,
      { audioFolder: true } as never,
    );
    expect(consentDetailText(row)).toBe("C:\\Public\\Users\\me\\Recordings");
    expect(consentDetailText({ kind: "log-folder", detail: both })).toBe("C:\\Public\\Users\\me\\Recordings");
    // The raw path stays reachable as the row's tooltip, capped head+tail like the row.
    const title = consentDetailTitle(row)!;
    expect(title.startsWith("C:\\Users\\me\\Recordings\\.\\")).toBe(true);
    expect(title).toContain(" … ");
    // One-sided padding resolves too; a path still past the cap once resolved keeps head+tail.
    const one = "C:\\Users\\me\\Recordings\\" + ".\\".repeat(2100) + "..\\..\\..\\Users\\Public\\x";
    expect(consentDetailText({ kind: "audio-folder", detail: one })).toBe("C:\\Users\\Public\\x");
    const stillLong = "C:\\" + "ab\\".repeat(1500) + ".\\x";
    const shown = consentDetailText({ kind: "audio-folder", detail: stillLong });
    expect(shown.startsWith("C:\\ab\\ab\\")).toBe(true);
    expect(shown.endsWith("ab\\x")).toBe(true);
    expect(shown).toContain(" … ");
  });
  it("resolves `.`, `..` and separator runs lexically, never above the root", () => {
    // Nothing to resolve: returned character for character (mixed and trailing separators too).
    for (const plain of [
      "C:\\Users\\me\\Recordings",
      "C:/Users/me/Recordings/",
      "D:\\",
      "\\\\fileserver\\share\\rec",
      "/home/me/recordings",
      "/home/me/recordings/",
      "/",
      "/home/me/.config/app",
      "C:\\a\\..b\\c.\\...",
    ]) {
      expect(resolvedFolderPath(plain)).toBe(plain);
      expect(consentDetailText({ kind: "audio-folder", detail: plain })).toBe(plain);
      expect(consentDetailTitle({ kind: "audio-folder", detail: plain })).toBeUndefined();
    }
    // POSIX rules for a POSIX path.
    expect(resolvedFolderPath("/home/me/recordings/../../../etc/cron.d")).toBe("/etc/cron.d");
    expect(consentDetailText({ kind: "log-folder", detail: "/home/me/logs/./../../../../tmp/x" })).toBe("/tmp/x");
    expect(resolvedFolderPath("//home///me/./x/")).toBe("/home/me/x");
    expect(resolvedFolderPath("/a/b\\..\\c")).toBe("/a/b\\..\\c");
    // Windows rules for a drive or UNC path: either separator, `..` stops at the drive / share.
    expect(resolvedFolderPath("C:\\a\\..\\..\\..\\b")).toBe("C:\\b");
    expect(resolvedFolderPath("C:/a//b/./c")).toBe("C:\\a\\b\\c");
    expect(resolvedFolderPath("C:\\\\a")).toBe("C:\\a");
    expect(resolvedFolderPath("\\\\host\\share\\a\\..\\..\\other")).toBe("\\\\host\\share\\other");
    expect(resolvedFolderPath("\\\\host/share/a/../b")).toBe("\\\\host\\share\\b");
    // A forward-slash `//host` is UNC only on Windows; elsewhere it is the POSIX `/host`.
    expect(resolvedFolderPath("//host/share/a/../b")).toBe("/host/share/b");
    expect(resolvedFolderPath("\\\\host\\share\\..")).toBe("\\\\host\\share");
    // A verbatim path is opened as written: shown as written.
    expect(resolvedFolderPath("\\\\?\\C:\\a\\..\\b")).toBe("\\\\?\\C:\\a\\..\\b");
  });
  it("resolves the path Rust opens: edges trimmed as `str::trim` trims them", () => {
    // A leading blank kept the root tests from seeing the path, so its `..` showed unresolved.
    const evil = " /home/me/Music/../../../tmp/evil";
    expect(resolvedFolderPath(evil)).toBe("/tmp/evil");
    expect(consentDetailText({ kind: "audio-folder", detail: evil })).toBe("/tmp/evil");
    expect(consentDetailTitle({ kind: "audio-folder", detail: evil })).toBe("\\u{0020}" + evil.slice(1));
    expect(resolvedFolderPath("\t\\\\host\\share\\a\\..\\..\\other")).toBe("\\\\host\\share\\other");
    // U+0085 is White_Space to Rust but not to JS `\s`.
    expect(resolvedFolderPath("\u0085C:\\Users\\me\\..\\..\\Public")).toBe("C:\\Public");
    expect(resolvedFolderPath("\u3000/a/b/..\u00a0")).toBe("/a");
    // A trailing "..  " is a `..` once trimmed.
    expect(resolvedFolderPath("/home/me/rec/..  ")).toBe("/home/me");
    // A padded path with nothing to resolve still differs from the raw one, so the tooltip shows it.
    expect(resolvedFolderPath(" /home/me/rec ")).toBe("/home/me/rec");
    expect(consentDetailTitle({ kind: "log-folder", detail: " /home/me/rec " })).toBeDefined();
    // U+FEFF is not White_Space: Rust keeps it, so the path stays relative and unresolved.
    expect(resolvedFolderPath("\ufeff/a/../b")).toBe("\ufeff/a/../b");
  });
  it("writes out what a folder path hides, so a `..`-lookalike reads as the name it is", () => {
    // Each component is a real directory name the display filter would draw as `..`.
    for (const [hidden, esc] of [
      ["\u200b", "\\u{200B}"],
      ["\u00ad", "\\u{00AD}"],
      ["\u2060", "\\u{2060}"],
      ["\u200d", "\\u{200D}"],
      ["\ufe0f", "\\u{FE0F}"],
      ["\u2800", "\\u{2800}"],
      ["\u00a0", "\\u{00A0}"],
      [" ", "\\u{0020}"],
    ]) {
      const detail = `/tmp/..${hidden}/..${hidden}/home/u/Recordings`;
      const shown = `/tmp/..${esc}/..${esc}/home/u/Recordings`;
      expect(consentDetailText({ kind: "audio-folder", detail })).toBe(shown);
      expect(consentDetailTitle({ kind: "log-folder", detail })).toBe(shown);
    }
    // Resolved AND escaped: the row shows the resolved path, the tooltip the raw one, both escaped.
    const both = "C:\\Users\\me\\..\\x\u200b\\rec";
    expect(consentDetailText({ kind: "audio-folder", detail: both })).toBe("C:\\Users\\x\\u{200B}\\rec");
    expect(consentDetailTitle({ kind: "audio-folder", detail: both })).toBe("C:\\Users\\me\\..\\x\\u{200B}\\rec");
    // Emoji and script sequences render as themselves, so they render as before; inner spaces too.
    for (const plain of [
      "/home/me/Musik ❤️",
      "/home/me/👨‍👩‍👧 photos",
      "C:\\Users\\me\\My Music\\क्‍ष",
      "/home/me/Ünïcödé/日本語",
    ]) {
      expect(consentDetailText({ kind: "audio-folder", detail: plain })).toBe(safeIdentityText(plain, 4096));
      expect(consentDetailTitle({ kind: "audio-folder", detail: plain })).toBeUndefined();
    }
    // Other rows are untouched.
    expect(consentDetailText({ kind: "save-recordings", detail: "a\u200bb" })).toBe("ab");
  });
  it("writes out a `..` lookalike, a repeated space and a joiner that shapes nothing", () => {
    const row = (detail: string) => consentDetailText({ kind: "audio-folder", detail });
    // A component that only reads as `..`: every code point but its ASCII dots is written out.
    expect(row("/tmp/\u2025/\u2025/home/u/Recordings")).toBe("/tmp/\\u{2025}/\\u{2025}/home/u/Recordings");
    expect(row("/tmp/\u2024\u2024/home/u/Recordings")).toBe("/tmp/\\u{2024}\\u{2024}/home/u/Recordings");
    expect(row("/tmp/..\u0307/..\u0323/home/u/Recordings")).toBe("/tmp/..\\u{0307}/..\\u{0323}/home/u/Recordings");
    expect(row("/tmp/\uff0e/rec")).toBe("/tmp/\\u{FF0E}/rec");
    expect(consentDetailTitle({ kind: "audio-folder", detail: "/tmp/\u2025/rec" })).toBe("/tmp/\\u{2025}/rec");
    // `...`, a dotted name and an ellipsis are names, not climbs.
    for (const plain of ["/home/u/...", "/home/u/.config", "/home/u/\u2026"]) expect(row(plain)).toBe(plain);
    // The display collapses a space run: its 2nd..Nth spaces are written out.
    expect(row("/home/u/My  Recordings")).toBe("/home/u/My \\u{0020}Recordings");
    expect(row("/home/u/My   Recordings")).toBe("/home/u/My \\u{0020}\\u{0020}Recordings");
    // A joiner after a Latin, Cyrillic or CJK letter, a second one in a row, or one before a
    // separator joins nothing; a VS16 after a letter is not an emoji.
    expect(row("/home/j\u00fc\u200drgen/Aufnahmen")).toBe("/home/j\u00fc\\u{200D}rgen/Aufnahmen");
    expect(row("/home/\u65e5\u200c\u672c")).toBe("/home/\u65e5\\u{200C}\u672c");
    expect(row("/home/u/\u00e9\u200d\u200d/x")).toBe("/home/u/\u00e9\\u{200D}\\u{200D}/x");
    expect(row("/home/\u044e\u0440\u0438\u0439/\u0417\u0430\u043f\u0438\ufe0f\u0441\u0438")).toBe(
      "/home/\u044e\u0440\u0438\u0439/\u0417\u0430\u043f\u0438\\u{FE0F}\u0441\u0438",
    );
    expect(row("/home/u/\u0628\u200c/x")).toBe("/home/u/\u0628\\u{200C}/x");
    expect(row("/home/u/\u0628\u200c x")).toBe("/home/u/\u0628\\u{200C} x");
    expect(row("/home/u/\u{1F44D}\u200d\u200d\u{1F44D}")).toBe("/home/u/\u{1F44D}\\u{200D}\\u{200D}\u{1F44D}");
    expect(row("/home/u/\u2764\ufe0f\ufe0f")).toBe("/home/u/\u2764 \\u{FE0F}") // the display draws the kept VS16 as a space;
    // A tag run off a flag, an unclosed one, and a keycap VS16 without its keycap stay escaped.
    expect(row("/home/u/a\u{E0067}\u{E007F}")).toBe("/home/u/a\\u{E0067}\\u{E007F}");
    expect(row("/home/u/\u{1F3F4}\u{E0067}\u{E0062}")).toBe("/home/u/\u{1F3F4}\\u{E0067}\\u{E0062}");
    expect(row("/home/u/1\ufe0fx")).toBe("/home/u/1\\u{FE0F}x");
    // A tag run that is no subdivision code (too long, a space or upper-case tag, a single tag)
    // is a payload the display draws as nothing.
    const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
    const esc = (s: string) => [...s].map((c) => `\\u{E00${(c.codePointAt(0)!).toString(16).toUpperCase()}}`).join("");
    for (const payload of ["gbengxyz", "gb eng", "GBENG", "g", "a".repeat(400)]) {
      expect(row(`/home/u/\u{1F3F4}${tags(payload)}\u{E007F}`)).toBe(`/home/u/\u{1F3F4}${esc(payload)}\\u{E007F}`);
    }
    // A joiner that sits between shapers but before nothing it shapes with.
    expect(row("/home/u/\u{1F600}\u200dx")).toBe("/home/u/\u{1F600}\\u{200D}x");
    expect(row("/home/u/\u2764\ufe0f\u200dx")).toBe("/home/u/\u2764 \\u{200D}x"); // kept VS16 drawn as a space
    expect(row("/home/u/\u{1F600}\u200d\u0915")).toBe("/home/u/\u{1F600}\\u{200D}\u0915");
    expect(row("/home/u/\u0628\u200cx")).toBe("/home/u/\u0628\\u{200C}x");
    expect(row("/home/u/\u0915\u094d\u200dx")).toBe("/home/u/\u0915\u094d\\u{200D}x");
    expect(row("/home/u/\u0915\u200d\u{1F600}")).toBe("/home/u/\u0915\\u{200D}\u{1F600}");
  });
  it("renders legitimate script, emoji, flag and keycap folder names as before", () => {
    for (const plain of [
      "/home/u/\u0646\u0627\u0645\u0647\u200c\u0647\u0627", // Persian ZWNJ
      "/home/u/\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
      "/home/u/\u0915\u094d\u200d\u0937", // Devanagari conjunct
      "/home/u/\u0915\u094d\u200c\u0937",
      "/home/u/\u{1F468}\u200d\u{1F469}\u200d\u{1F467}", // family
      "/home/u/\u{1F469}\u{1F3FD}\u200d\u{1F4BB}", // skin tone + ZWJ
      "/home/u/\u2764\ufe0f\u200d\u{1F525}", // VS16 then ZWJ
      "/home/u/\u{1F3F3}\ufe0f\u200d\u{1F308}", // rainbow flag
      "/home/u/\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // England
      "/home/u/\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} x", // Scotland
      "/home/u/\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}", // Wales
      "/home/u/\u{1F3F3}\ufe0f\u200d\u26a7\ufe0f", // transgender flag
      "/home/u/\u{1F43B}\u200d\u2744\ufe0f", // polar bear
      "/home/u/\u{1F9D1}\u200d\u{1F9B0}", // person: red hair
      "/home/u/\u{1F3C3}\u200d\u27a1\ufe0f", // facing right
      "/home/u/\u09b0\u200d\u09cd\u09af", // Bengali ya-phala after ra
      "/home/u/\u0dc1\u0dca\u200d\u0dbb\u0dd3", // Sinhala shri
      "/home/u/1\ufe0f\u20e3", // keycap
      "/home/u/#\ufe0f\u20e3 Takes",
      "/home/u/Musik \u2764\ufe0f",
      "/home/u/My Recordings",
      "/home/u/\u65e5\u672c\u8a9e/\u97f3\u58f0",
      "/home/u/\u05d4\u05e7\u05dc\u05d8\u05d5\u05ea",
      "C:\\Users\\me\\My Music",
    ]) {
      expect(consentDetailText({ kind: "audio-folder", detail: plain })).toBe(safeIdentityText(plain, 4096));
      expect(consentDetailTitle({ kind: "audio-folder", detail: plain })).toBeUndefined();
      expect(folderPathText(plain, 200)).toBe(safeIdentityText(plain, 200));
    }
  });
  it("the Settings folder readouts render a path as the consent row does", () => {
    for (const plain of ["~/Recordings", "C:\\Users\\me\\My Music", "/home/me/Musik ❤️"]) {
      expect(folderPathText(plain, 200)).toBe(safeIdentityText(plain, 200));
    }
    expect(folderPathText("/tmp/..\u200b/rec", 120)).toBe("/tmp/..\\u{200B}/rec");
    const long = "/" + "ab/".repeat(100) + "tmp/evil";
    const shown = folderPathText(long, 120);
    expect(shown.startsWith("/ab/ab/")).toBe(true);
    expect(shown.endsWith("ab/tmp/evil")).toBe(true);
  });
  it("reads a `/\\` path by POSIX rules off Windows", () => {
    // Linux opens `/` + a `\home\me` file name, not a UNC share.
    expect(resolvedFolderPath("/\\home\\me/../tmp")).toBe("/tmp");
    expect(resolvedFolderPath("/\\home\\me/a/../../../tmp/evil")).toBe("/tmp/evil");
  });
  it("counts the trimmed length against the openable cap, and writes blank edges out compactly", () => {
    // Rust trims before it opens, so padding past the cap must not get the path shown raw.
    const core = "/tmp/..​/..​/home/u/Recordings";
    const shown = "/tmp/..\\u{200B}/..\\u{200B}/home/u/Recordings";
    for (const detail of [core + " ".repeat(33000), " ".repeat(33000) + core]) {
      expect(consentDetailText({ kind: "audio-folder", detail })).toBe(shown);
      const title = consentDetailTitle({ kind: "audio-folder", detail });
      expect(title).toBe(detail.startsWith(" ") ? `\\u{0020}×33000${shown}` : `${shown}\\u{0020}×33000`);
      expect(folderPathText(detail, 4096)).toBe(title);
    }
    expect(resolvedFolderPath("/a/../tmp" + " ".repeat(40000))).toBe("/tmp");
    // A mixed edge: runs of one code point each, then the rest counted.
    expect(consentDetailTitle({ kind: "log-folder", detail: "\t\t /x/../y" })).toBe("\\u{0009}×2\\u{0020}/x/../y");
    const mixed = " \t".repeat(20) + "/x";
    expect(consentDetailTitle({ kind: "log-folder", detail: mixed })).toBe(
      "\\u{0020}\\u{0009}".repeat(4) + "…×32/x",
    );
    // Megabytes of padding stay cheap to render.
    const padded = " 　".repeat(1 << 20) + core + " ".repeat(1 << 21);
    const t0 = performance.now();
    expect(consentDetailText({ kind: "audio-folder", detail: padded })).toBe(shown);
    expect(consentDetailTitle({ kind: "audio-folder", detail: padded })).toContain("…×");
    // The "…×" above already proves the compact form; the bound is a backstop that a loaded
    // full-suite run must not trip (it did once at 500 ms).
    expect(performance.now() - t0).toBeLessThan(2000);
    // A core still past the cap once trimmed is left raw: no OS opens it.
    const huge = " " + "/" + "./".repeat(20000) + "../tmp";
    expect(resolvedFolderPath(huge)).toBe(huge);
  });
  it("writes out a component made only of dot lookalikes NFKD keeps", () => {
    const row = (detail: string) => consentDetailText({ kind: "audio-folder", detail });
    for (const dot of ["ꓸ", "٠", "۰", "܁", "܂", "꘎", "\u{10A50}"]) {
      const esc = `\\u{${dot.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
      expect(row(`/tmp/${dot}${dot}/${dot}${dot}/home/u/Recordings`)).toBe(`/tmp/${esc}${esc}/${esc}${esc}/home/u/Recordings`);
      expect(row(`/tmp/.${dot}/rec`)).toBe(`/tmp/.${esc}/rec`);
      expect(row(`/tmp/${dot}/rec`)).toBe(`/tmp/${esc}/rec`);
    }
    // A real Arabic or Persian name with those zeros among letters or digits renders unchanged.
    for (const plain of [
      "/home/u/ملف٠١", // ملف٠١
      "/home/u/٢٠٢٤", // ٢٠٢٤
      "/home/u/۱۰", // ۱۰
      "/home/u/۱۴۰۰/ضبط", // ۱۴۰۰/ضبط
      "/home/u/ضبط ۰۲",
    ]) {
      expect(row(plain)).toBe(safeIdentityText(plain, 4096));
      expect(consentDetailTitle({ kind: "audio-folder", detail: plain })).toBeUndefined();
    }
  });
  it("writes out a separator lookalike anywhere in a folder path", () => {
    const row = (detail: string) => consentDetailText({ kind: "audio-folder", detail });
    for (const sep of ["⁄", "∕", "∖", "╱", "╲", "⧵", "⧸", "⧹", "﹨", "／", "＼", "⟋", "⟍", "᜵"]) {
      const esc = `\\u{${sep.codePointAt(0)!.toString(16).toUpperCase()}}`;
      const detail = `/tmp/x${sep}..${sep}home${sep}u${sep}Recordings`;
      const shown = `/tmp/x${esc}..${esc}home${esc}u${esc}Recordings`;
      expect(row(detail)).toBe(shown);
      expect(consentDetailTitle({ kind: "log-folder", detail })).toBe(shown);
      expect(folderPathText(detail, 200)).toBe(shown);
    }
    // A joiner before one joins nothing.
    expect(row("/home/u/ب‍∕x")).toBe("/home/u/ب\\u{200D}\\u{2215}x");
  });
  it("leaves a path no OS opens as it is, without resolving it", () => {
    const huge = "/" + "./".repeat(20000) + "../tmp";
    const t0 = performance.now();
    expect(resolvedFolderPath(huge)).toBe(huge);
    expect(performance.now() - t0).toBeLessThan(200);
    // One at the Windows limit still resolves.
    const edge = "/a/.." + "/b".repeat((32767 - 5) / 2);
    expect(edge.length).toBe(32767);
    expect(resolvedFolderPath(edge)).toBe("/b".repeat((32767 - 5) / 2));
  });
});

describe("an unattended pull that moves a synced folder", () => {
  /** A v1 base with both folder switches on; the peer then moves the audio folder to `UNC`
   *  and changes an unrelated chip setting. */
  async function seed(): Promise<void> {
    await resetSyncState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = {
      ...settings.sync!,
      enabled: true,
      backendId: "b1",
      sub: { ...DEFAULT_SETTING_SYNC, audioFolder: true, recordingsDir: true, logFolder: true },
    };
    settings.recording = { ...settings.recording, audioBaseDir: "/home/me/audio" };
    useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
    await pushNow(true);
    const remote = structuredClone(api.pushed) as SyncBlob;
    remote.recording = { ...remote.recording, audioBaseDir: UNC } as never;
    remote.logging = { ...remote.logging, logDir: "\\\\attacker.example\\logs" } as never;
    remote.chip = { ...remote.chip, dotScale: 2 } as never;
    api.pull = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  }

  it("holds the folder categories until approved and applies everything else", async () => {
    await seed();
    await pullNow(true);
    expect(getPendingReview()?.changes.map((c) => c.kind).sort()).toEqual(["audio-folder", "log-folder"]);
    const held = useApp.getState().settings;
    expect(held.recording.audioBaseDir).toBe("/home/me/audio");
    expect(held.logging?.logDir ?? null).toBeNull();
    expect(held.recording.dotScale).toBe(2); // the unrelated chip change applied
    await approvePendingReview();
    expect(getPendingReview()).toBeNull();
    const after = useApp.getState().settings;
    expect(after.recording.audioBaseDir).toBe(UNC);
    expect(after.logging?.logDir).toBe("\\\\attacker.example\\logs");
  });

  it("asks nothing when this device's folder switches are off", async () => {
    await seed();
    const s = useApp.getState().settings;
    useApp.setState({
      settings: { ...s, sync: { ...s.sync!, sub: { ...s.sync!.sub!, audioFolder: false, recordingsDir: false, logFolder: false } } },
    });
    await pullNow(true);
    expect(getPendingReview()).toBeNull();
    expect(useApp.getState().settings.recording.audioBaseDir).toBe("/home/me/audio");
    expect(useApp.getState().settings.recording.dotScale).toBe(2);
  });
});
