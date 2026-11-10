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
    expect(consentDetailTitle({ kind: "audio-folder", detail: evil })).toBe(safeIdentityText(evil, 4096));
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
  it("reads a `/\\` path by POSIX rules off Windows", () => {
    // Linux opens `/` + a `\home\me` file name, not a UNC share.
    expect(resolvedFolderPath("/\\home\\me/../tmp")).toBe("/tmp");
    expect(resolvedFolderPath("/\\home\\me/a/../../../tmp/evil")).toBe("/tmp/evil");
  });
  it("leaves a path no OS opens as it is, without resolving it", () => {
    const huge = "/" + "./".repeat(20000) + "../tmp";
    const t0 = performance.now();
    expect(resolvedFolderPath(huge)).toBe(huge);
    expect(performance.now() - t0).toBeLessThan(50);
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
