// Baseline fixtures locking the sync engine's compose/apply/merge behavior
// BEFORE (and after) the per-setting gate refactor — the wire-neutrality
// proof. Outside Tauri every api call no-ops, so composeBlob/applyBlob run
// as pure-ish functions over the store.

import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES,
  applyBlob,
  composeBlob,
  mergeBlobs,
  migrateBlob,
} from "./sync";
import { useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { IS_WINDOWS } from "./platform";
import type { SyncBlob } from "./syncTypes";
import type { AppSettings, Backend, Profile, SyncCategory, SyncSubSettings } from "./types";

const CATS_ALL = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<
  SyncCategory,
  boolean
>;
const LEGACY_SUB: SyncSubSettings = {
  recordingsDir: false,
  profileHotkeys: true,
  quickAddHotkey: true,
  transcribePicks: false,
};

function settings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function backend(over: Partial<Backend> = {}): Backend {
  return {
    id: "b1",
    name: "local",
    serverUrl: "http://10.0.0.2:8000",
    hasApiKey: false,
    model: "large-v3",
    endpoint: "transcriptions",
    language: "auto",
    responseFormat: "verbose_json",
    kind: "faster-whisper",
    ...over,
  } as Backend;
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Default",
    activation: "toggle",
    enabled: true,
    hotkey: ["ControlLeft", "Space"],
    backendId: "b1",
    ...over,
  } as Profile;
}

function slice(over: Partial<{ settings: AppSettings; backends: Backend[]; profiles: Profile[] }> = {}) {
  return {
    settings: settings(),
    backends: [backend()],
    profiles: [profile()],
    appRules: [],
    ...over,
  };
}

describe("composeBlob passthrough (baseline)", () => {
  it("audio-folder gate off: snapshot's paths travel, live edits stay local", async () => {
    const cfg = slice();
    cfg.settings.recording.audioBaseDir = "/home/me/local-audio";
    cfg.settings.recording.recordingsDir = "/home/me/legacy";
    const snapshot: SyncBlob = {
      recording: { audioBaseDir: "/peer/audio", recordingsDir: null } as never,
    };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: LEGACY_SUB,
    });
    expect(blob.recording?.audioBaseDir).toBe("/peer/audio");
    expect(blob.recording?.recordingsDir).toBe(null);
  });

  it("audio-folder gate off + no snapshot: paths omitted (absent ≠ delete)", async () => {
    const cfg = slice();
    cfg.settings.recording.audioBaseDir = "/home/me/local-audio";
    const blob = await composeBlob(cfg, CATS_ALL, undefined, {
      includeSecrets: false,
      sub: LEGACY_SUB,
    });
    expect(blob.recording).toBeTruthy();
    expect("audioBaseDir" in (blob.recording as object)).toBe(false);
  });

  it("transcribe-picks gate off: snapshot picks travel, options stay live", async () => {
    const cfg = slice();
    cfg.settings.transcribe = { backendId: "bX", model: "small", diarize: true };
    const snapshot: SyncBlob = { transcription: { backendId: "bS", model: "medium" } };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: LEGACY_SUB,
    });
    expect(blob.transcription?.backendId).toBe("bS");
    expect(blob.transcription?.model).toBe("medium");
    expect(blob.transcription?.diarize).toBe(true);
  });

  it("profile-shortcuts gate off: known ids ship the snapshot's chord, new ids their live chord", async () => {
    const cfg = slice({
      profiles: [profile(), profile({ id: "p2", name: "New", hotkey: ["F9"] })],
    });
    const snapshot: SyncBlob = {
      profiles: { list: [profile({ hotkey: ["AltLeft", "KeyD"] })], homeProfileId: null },
    };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: { ...LEGACY_SUB, profileHotkeys: false },
    });
    const byId = new Map(blob.profiles!.list.map((p) => [p.id, p]));
    expect(byId.get("p1")!.hotkey).toEqual(["AltLeft", "KeyD"]);
    expect(byId.get("p2")!.hotkey).toEqual(["F9"]);
  });

  it("a category toggled OFF passes through whole from the snapshot", async () => {
    const snapshot: SyncBlob = { chip: { indicatorPosition: "bottom" } as never };
    const blob = await composeBlob(
      slice(),
      { ...CATS_ALL, chip: false },
      snapshot,
      { includeSecrets: false, sub: LEGACY_SUB },
    );
    expect(blob.chip).toEqual(snapshot.chip);
  });

  it("absent categories are dropped, not nulled", async () => {
    const blob = await composeBlob(
      slice(),
      { ...CATS_ALL, appRules: false },
      undefined,
      { includeSecrets: false, sub: LEGACY_SUB },
    );
    expect("appRules" in blob).toBe(false);
  });
});

describe("migrateBlob (baseline)", () => {
  it("splits a pre-split recording payload into recording + chip", () => {
    const old: SyncBlob = {
      recording: { saveRecordings: true, indicatorPosition: "top", persistentDock: false } as never,
    };
    const out = migrateBlob(old);
    expect((out.recording as Record<string, unknown>).saveRecordings).toBe(true);
    expect("indicatorPosition" in (out.recording as object)).toBe(false);
    expect((out.chip as Record<string, unknown>).indicatorPosition).toBe("top");
    expect((out.chip as Record<string, unknown>).persistentDock).toBe(false);
  });

  it("moves the quick-add chord from general to dictionary", () => {
    const out = migrateBlob({
      general: { quickAddHotkey: ["AltLeft", "MetaLeft"] } as never,
    });
    expect("quickAddHotkey" in (out.general as object)).toBe(false);
    expect(out.dictionary?.quickAddHotkey).toEqual(["AltLeft", "MetaLeft"]);
  });
});

describe("mergeBlobs (baseline)", () => {
  const base: SyncBlob = { general: { soundEffects: true } as never };
  it("only-one-side-changed auto-resolves; both-changed conflicts", () => {
    const local: SyncBlob = { general: { soundEffects: false } as never };
    const remote: SyncBlob = { general: { soundEffects: true } as never };
    expect(mergeBlobs(base, local, remote)).toEqual({
      merged: local,
      conflicts: [],
    });
    const remote2: SyncBlob = { general: { soundEffects: true, autoEnter: true } as never };
    const r = mergeBlobs(base, local, remote2);
    expect(r.conflicts).toEqual(["general"]);
  });

  it("appRules merge per-OS bucket instead of conflicting", () => {
    const b: SyncBlob = { appRules: { linux: [], windows: [] } };
    const local: SyncBlob = {
      appRules: { linux: [{ id: "r1", appId: "konsole", name: "Konsole", block: false } as never], windows: [] },
    };
    const remote: SyncBlob = {
      appRules: { linux: [], windows: [{ id: "r2", appId: "cmd.exe", name: "cmd", block: true } as never] },
    };
    const r = mergeBlobs(b, local, remote);
    expect(r.conflicts).toEqual([]);
    expect(r.merged.appRules?.linux).toHaveLength(1);
    expect(r.merged.appRules?.windows).toHaveLength(1);
  });
});

describe("applyBlob keep-local (baseline)", () => {
  beforeEach(() => {
    useApp.setState({
      settings: settings(),
      backends: [backend()],
      profiles: [profile()],
      appRules: [],
      status: "idle",
    });
  });

  it("audio-folder gate off: inbound paths never overwrite local", async () => {
    const s = settings();
    s.recording.audioBaseDir = "/home/me/mine";
    useApp.setState({ settings: s });
    await applyBlob(
      { recording: { saveRecordings: false, audioBaseDir: "/peer/audio", recordingsDir: "/peer/x" } as never },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const after = useApp.getState().settings;
    expect(after.recording.saveRecordings).toBe(false); // non-gated field applied
    expect(after.recording.audioBaseDir).toBe("/home/me/mine"); // gated field kept
    expect(after.recording.recordingsDir).toBe(null);
  });

  it("profile-shortcuts gate off: known profiles keep this device's chord", async () => {
    const s = settings();
    s.sync = { ...s.sync!, sub: { ...LEGACY_SUB, profileHotkeys: false } };
    useApp.setState({ settings: s });
    await applyBlob(
      {
        profiles: {
          list: [
            profile({ hotkey: ["AltLeft", "KeyZ"], name: "Renamed" }),
            profile({ id: "p9", name: "FromPeer", hotkey: ["F6"], backendId: null }),
          ],
          homeProfileId: null,
        },
      },
      { ...CATS_ALL, backends: false },
    );
    const byId = new Map(useApp.getState().profiles.map((p) => [p.id, p]));
    expect(byId.get("p1")!.hotkey).toEqual(["ControlLeft", "Space"]); // local chord kept
    expect(byId.get("p1")!.name).toBe("Renamed"); // rest applied
    expect(byId.get("p9")!.hotkey).toEqual(["F6"]); // new profile keeps inbound
  });

  it("machine-local general fields never apply from a blob", async () => {
    await applyBlob(
      { general: { soundEffects: false, evdevEnabled: true, autoEnter: true } as never },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const g = useApp.getState().settings.general;
    expect(g.soundEffects).toBe(false);
    expect(g.evdevEnabled).toBe(false); // stripped on the way in
    expect(g.autoEnter).toBe(false); // ditto (post-paste Return is armed locally only)
  });

  it("a peer cannot arm the post-paste Return through a PROFILE override either", async () => {
    // The twin of the `general` strip above. `autoEnter` moved onto Profile and AppRule as
    // an override, and `sanitizeProfiles` carries unlisted leaves through by reference — so
    // without an explicit drop this is a way around the very defense the general strip is.
    useApp.setState({
      settings: settings(),
      profiles: [
        { id: "p1", name: "Mine", activation: "handsfree", enabled: true, hotkey: ["F5"], backendId: null },
      ],
    });
    await applyBlob(
      {
        profiles: {
          list: [
            {
              id: "p1",
              name: "Mine",
              activation: "handsfree",
              enabled: true,
              hotkey: ["F5"],
              backendId: null,
              insertionOverrides: { autoEnter: true, insertMethod: "direct" },
            },
          ],
          homeProfileId: null,
        } as never,
      },
      { ...CATS_ALL, backends: false },
    );
    const p = useApp.getState().profiles.find((x) => x.id === "p1")!;
    expect(p.insertionOverrides?.autoEnter).toBeUndefined(); // stripped
    expect(p.insertionOverrides?.insertMethod).toBe("direct"); // the rest still applies
  });

  it("a peer cannot arm the post-paste Return through an APP RULE override either", async () => {
    useApp.setState({
      settings: settings(),
      appRules: [{ id: "r1", appId: "konsole", block: false }],
    });
    await applyBlob(
      {
        appRules: {
          [IS_WINDOWS ? "windows" : "linux"]: [
            { id: "r1", appId: "konsole", block: false, autoEnter: true, insertMethod: "direct" },
          ],
        } as never,
      },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const r = useApp.getState().appRules.find((x) => x.id === "r1")!;
    expect(r.autoEnter ?? undefined).toBeUndefined(); // stripped + re-pinned to local (unset)
    expect(r.insertMethod).toBe("direct"); // the rest still applies
  });

  it("an omitted field keeps the local value (merge-over-current, no default refill)", async () => {
    const s = settings();
    s.recording.saveRecordings = false;
    useApp.setState({ settings: s });
    await applyBlob(
      { recording: { trimSilence: false } as never },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const rec = useApp.getState().settings.recording;
    expect(rec.saveRecordings).toBe(false); // omitted key did NOT reset to factory default
    expect(rec.trimSilence).toBe(false);
  });
});
