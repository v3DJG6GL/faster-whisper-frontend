// A synced audio/log folder change (the "Audio folder" / "Log folder" switches) moves where every
// later recording, audio copy or session log is written — on Windows a UNC path sends them to a
// network host. An unattended pull holds such a move for the security review, like a repointed
// server; a move back to the default, an unchanged value and a gated-off path never prompt.

import { describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  categorySelection,
  consentDetailCap,
  getPendingReview,
  pullNow,
  pushNow,
  resetSyncState,
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
    expect(consentDetailCap("log-folder")).toBe(consentDetailCap("audio-folder"));
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
