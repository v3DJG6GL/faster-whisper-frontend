// Baseline fixtures locking the sync engine's compose/apply/merge behavior
// BEFORE (and after) the per-setting gate refactor — the wire-neutrality
// proof. Outside Tauri every api call no-ops, so composeBlob/applyBlob run
// as pure-ish functions over the store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBlob,
  categorySelection,
  composeBlob,
  disableConflictingProfiles,
  hasPendingApplyForTests,
  mergeBlobs,
  migrateBlob,
  persistSnapshotSecretsForTests,
  rejectPendingReview,
  restorableCategories,
  restoreSnapshotSecretsForTests,
  sanitizeBackends,
  sanitizeProfiles,
  securityChanges,
} from "./sync";
import { useApp } from "../store";
import { credentialGeneration } from "../capabilities";
import { DEFAULT_SETTINGS } from "../defaults";
import { IS_WINDOWS } from "../platform";
import type { SyncBlob } from "./syncTypes";
import type { AppSettings, Backend, Profile, SyncSubSettings } from "../types";
import { backend } from "./syncTestFixtures";
import { DEFAULT_SETTING_SYNC } from "../settingsManifest";

/** Test seam for the ONE await inside applyBlob (the keyring reconciliation): while it is
 *  parked, the store is live and the user can keep editing. Default is passthrough; `keys`
 *  answers an unparked read (what this device's keyring holds). `store`, when set, is a live
 *  keyring that reads, writes and deletes go through — refusing a value over wincred's 1280
 *  UTF-16 units and any write to an account in `failWrites`, and folding a lone surrogate to
 *  U+FFFD as the IPC hop does. `writes` records every account a write was issued for, and a write
 *  to an account in `parkWrites` waits on that promise before it lands. A delete waits on every
 *  `parkWrites` promise first, as Rust's FIFO keyring lock holds it behind a parked write, and
 *  `deletes` records every account one landed for, and `reads` counts the key reads issued. */
const keyring = vi.hoisted(() => ({
  park: null as null | Promise<Record<string, string>>,
  keys: null as null | Record<string, string>,
  store: null as null | Map<string, string>,
  failWrites: new Set<string>(),
  writes: [] as string[],
  parkWrites: new Map<string, Promise<void>>(),
  deletes: [] as string[],
  reads: 0,
}));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    readBackendKeys: (ids: string[]) => {
      keyring.reads++;
      return (
        keyring.park ??
        (keyring.keys
          ? Promise.resolve(keyring.keys)
          : keyring.store
            ? Promise.resolve(Object.fromEntries(ids.flatMap((id) => (keyring.store!.has(id) ? [[id, keyring.store!.get(id)!]] : []))))
            : orig.readBackendKeys(ids))
      );
    },
    setBackendKey: async (id: string, key: string) => {
      if (!keyring.store) return orig.setBackendKey(id, key);
      keyring.writes.push(id);
      const parked = keyring.parkWrites.get(id);
      if (parked) await parked;
      if (key.length > 1280 || keyring.failWrites.has(id)) throw new Error("TooLong");
      keyring.store.set(id, key.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"));
    },
    deleteBackendKey: async (id: string) => {
      if (!keyring.store) return orig.deleteBackendKey(id);
      await Promise.all([...keyring.parkWrites.values()]);
      keyring.deletes.push(id);
      keyring.store.delete(id);
    },
  };
});

const CATS_ALL = categorySelection(true);
const LEGACY_SUB: SyncSubSettings = {
  recordingsDir: false,
  profileHotkeys: true,
  quickAddHotkey: true,
  transcribePicks: false,
};

function settings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Default",
    activation: "hold",
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

  it("transcribe-picks gate off: the translation-model pick travels from the snapshot, like model", async () => {
    // It names a model on the saved backend's server, so it is a pick, not a portable default:
    // a live pick here would land under a peer's different backend.
    const cfg = slice();
    cfg.settings.transcribe = { backendId: "bX", translationModel: "local-m", translationMode: "faithful" };
    const snapshot: SyncBlob = { transcription: { backendId: "bS", translationModel: "snap-m" } };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: LEGACY_SUB,
    });
    expect(blob.transcription?.translationModel).toBe("snap-m");
    expect(blob.transcription?.translationMode).toBe("faithful");
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

  it("API-keys gate off: no keyring read, so a locked wallet cannot hold back the live backend list", async () => {
    // The gate pass carries the snapshot's keys whatever the read returns, yet a locked wallet's
    // empty read diverted the whole list to the snapshot's copy (a local edit never pushed) and
    // marked the compose degraded, holding every incoming backend change behind a keyring error.
    const allOn = Object.fromEntries(Object.keys(DEFAULT_SETTING_SYNC).map((k) => [k, true]));
    const gates = { ...(allOn as typeof DEFAULT_SETTING_SYNC), apiKeys: false };
    const snapshot: SyncBlob = { backends: { list: [backend({ hasApiKey: true })], secrets: { b1: "sk-peer" } } };
    const live = [backend({ hasApiKey: true, name: "renamed" }), backend({ id: "b2", hasApiKey: true })];
    keyring.keys = {}; // the locked wallet's degraded read
    keyring.reads = 0;
    try {
      const blob = await composeBlob(slice({ backends: live }), CATS_ALL, snapshot, {
        includeSecrets: true,
        sub: LEGACY_SUB,
        gates,
      });
      expect(blob.backends?.list).toEqual(live);
      expect(blob.backends?.secrets).toEqual({ b1: "sk-peer" });
      expect(keyring.reads).toBe(0);
    } finally {
      keyring.keys = null;
    }
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

  it("a non-object dictionary container is treated as absent, never spread per code unit", () => {
    const out = migrateBlob({
      general: { quickAddHotkey: ["KeyA"] } as never,
      dictionary: "x".repeat(1000) as never,
    });
    expect(Object.keys(out.dictionary as object)).toEqual(["quickAddHotkey"]);
    const out2 = migrateBlob({
      backends: { list: [], quickAddList: { backendId: "b1", slug: "x" } } as never,
      dictionary: "y".repeat(1000) as never,
    });
    expect(Object.keys(out2.dictionary as object)).toEqual(["quickAddList"]);
  });

  it("a non-object ROOT is treated as an empty blob, never spread per code unit", () => {
    expect(migrateBlob("abc" as never)).toEqual({});
  });
});

describe("restorableCategories (the restore offers' gate and chips)", () => {
  it("a blob with nothing applyBlob would restore offers nothing", () => {
    expect(restorableCategories(null)).toEqual([]);
    expect(restorableCategories(undefined)).toEqual([]);
    // A peer syncing with every category off composes `{}`.
    expect(restorableCategories({})).toEqual([]);
    expect(restorableCategories({ general: null } as never)).toEqual([]);
    expect(restorableCategories("abc" as never)).toEqual([]);
    // Only a forward-compat key from a newer client.
    expect(restorableCategories({ futureCat: {} } as never)).toEqual([]);
  });

  it("counts pre-split categories after migration", () => {
    const cats = restorableCategories({ recording: { indicatorPosition: "top" } } as never);
    expect(cats).toContain("chip");
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

  it("refuses (returns false, applies nothing) while dictation is live", async () => {
    useApp.setState({ status: "recording" as never });
    const before = useApp.getState().settings;
    const applied = await applyBlob(
      { chip: { indicatorPosition: "bottom" } as never },
      CATS_ALL,
    );
    expect(applied).toBe(false);
    expect(useApp.getState().settings).toBe(before); // untouched — refused, nothing stashed
    useApp.setState({ status: "idle" });
    expect(await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL)).toBe(true);
  });

  it("a one-shot restore refused while dictating parks no re-pull; a pull-apply does", async () => {
    // Onboarding's restore calls applyBlob with ignoreGates and no idle pre-check: it parked the
    // whole blob and triggered a pointless re-pull at the session's end.
    rejectPendingReview(); // drops the re-pull the "refuses while dictation is live" test parked
    useApp.setState({ status: "recording" as never });
    try {
      const blob = { chip: { indicatorPosition: "bottom" } as never };
      expect(await applyBlob(blob, CATS_ALL, 2, { ignoreGates: true })).toBe(false);
      expect(hasPendingApplyForTests()).toBe(false);
      expect(await applyBlob(blob, CATS_ALL)).toBe(false);
      expect(hasPendingApplyForTests()).toBe(true);
    } finally {
      useApp.setState({ status: "idle" });
      rejectPendingReview();
    }
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

  it("a non-boolean askTranslationTargets is clamped before it can wedge save_config", async () => {
    // Rust parses it as `Option<bool>` with no fallback; one bad leaf fails every later save.
    useApp.setState({ settings: settings(), profiles: [] });
    await applyBlob(
      {
        profiles: {
          list: [
            { id: "p1", name: "A", activation: "handsfree", enabled: true, hotkey: ["F5"], backendId: null,
              askTranslationTargets: "yes" },
            { id: "p2", name: "B", activation: "handsfree", enabled: true, hotkey: ["F6"], backendId: null,
              askTranslationTargets: true },
          ],
          homeProfileId: null,
        } as never,
      },
      { ...CATS_ALL, backends: false },
    );
    const byId = Object.fromEntries(useApp.getState().profiles.map((p) => [p.id, p]));
    expect(byId.p1.askTranslationTargets).toBe(false);
    expect(byId.p2.askTranslationTargets).toBe(true);
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

  it("this device's own per-profile Return survives a pull with profile insertion sync ON", async () => {
    // The strip above must not also erase the value THIS device configured: the app-rule
    // twin repins `autoEnter` ungated, and the profile path needs the same half.
    useApp.setState({
      settings: settings(),
      profiles: [
        { id: "p1", name: "Mine", activation: "handsfree", enabled: true, hotkey: ["F5"], backendId: null,
          insertionOverrides: { autoEnter: true } },
      ],
    });
    await applyBlob(
      {
        profiles: {
          list: [
            { id: "p1", name: "Mine", activation: "handsfree", enabled: true, hotkey: ["F5"], backendId: null,
              insertionOverrides: { insertMethod: "direct" } },
            { id: "p2", name: "Theirs", activation: "handsfree", enabled: true, hotkey: ["F6"], backendId: null,
              insertionOverrides: { autoEnter: true } },
          ],
          homeProfileId: null,
        } as never,
      },
      { ...CATS_ALL, backends: false },
    );
    const mine = useApp.getState().profiles.find((x) => x.id === "p1")!;
    expect(mine.insertionOverrides?.autoEnter).toBe(true); // kept
    expect(mine.insertionOverrides?.insertMethod).toBe("direct"); // inbound still applies
    const theirs = useApp.getState().profiles.find((x) => x.id === "p2")!;
    expect(theirs.insertionOverrides?.autoEnter).toBeUndefined(); // unknown here: nothing to keep
  });

  it("translationMode travels in the transcription block and is clamped on apply", async () => {
    const cfg = slice();
    cfg.settings.transcribe = { ...cfg.settings.transcribe, translationMode: "faithful" };
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.transcription?.translationMode).toBe("faithful");
    useApp.setState({ settings: settings() });
    await applyBlob({ transcription: { translationMode: "faithful" } as never }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.translationMode).toBe("faithful");
    await applyBlob({ transcription: { translationMode: "loose" } as never }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.translationMode).toBe("faithful"); // bogus value dropped
  });

  it("subtitle cue settings travel in the transcription block and are clamped on apply", async () => {
    const cfg = slice();
    cfg.settings.transcribe = {
      ...cfg.settings.transcribe, subtitleLength: "custom", translationTiming: "own",
      subtitleCustom: { cpl: 37, lines: 2, maxDur: 6, cps: 15 },
    };
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.transcription).toMatchObject({ subtitleLength: "custom", translationTiming: "own" });
    useApp.setState({ settings: settings() });
    await applyBlob(
      { transcription: { subtitleLength: "short", translationTiming: "own", subtitleCustom: { cpl: 999, lines: 0, maxDur: 6, cps: 15 } } as never },
      { ...CATS_ALL, backends: false },
    );
    const t = useApp.getState().settings.transcribe;
    expect(t).toMatchObject({ subtitleLength: "short", translationTiming: "own", subtitleCustom: { cpl: 60, lines: 1, maxDur: 6, cps: 15 } });
    await applyBlob(
      { transcription: { subtitleLength: "huge", translationTiming: "late", subtitleCustom: { cpl: "x" } } as never },
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().settings.transcribe).toMatchObject({ subtitleLength: "short", translationTiming: "own", subtitleCustom: { cpl: 60 } });
  });

  it("revealAfterSave travels in the transcription block; a non-boolean is dropped on apply", async () => {
    const cfg = slice();
    cfg.settings.transcribe = { ...cfg.settings.transcribe, revealAfterSave: false };
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.transcription?.revealAfterSave).toBe(false);
    useApp.setState({ settings: settings() });
    await applyBlob({ transcription: { revealAfterSave: false } }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.revealAfterSave).toBe(false);
    await applyBlob({ transcription: { revealAfterSave: "no" } as never }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.revealAfterSave).toBe(false); // bogus value dropped
    await applyBlob({ transcription: { revealAfterSave: true } }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.revealAfterSave).toBe(true);
  });

  it("the export Media defaults and the link-video keep settings travel; bad values are dropped", async () => {
    const cfg = slice();
    cfg.settings.transcribe = {
      ...cfg.settings.transcribe,
      exportMedia: "video", exportContainer: "mp4", exportSubtitleMode: "both",
      keepUrlVideoCopies: false, urlVideoMaxHeight: 720,
    };
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.transcription).toMatchObject({ exportMedia: "video", exportContainer: "mp4", exportSubtitleMode: "both" });
    expect(blob.fileTranscriptions).toMatchObject({ keepUrlVideoCopies: false, urlVideoMaxHeight: 720 });
    useApp.setState({ settings: settings() });
    await applyBlob(
      {
        transcription: { exportMedia: "audio", exportContainer: "mkv", exportSubtitleMode: "sidecar" },
        fileTranscriptions: { keepUrlVideoCopies: false, urlVideoMaxHeight: 1080 },
      },
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().settings.transcribe).toMatchObject({
      exportMedia: "audio", exportContainer: "mkv", exportSubtitleMode: "sidecar",
      keepUrlVideoCopies: false, urlVideoMaxHeight: 1080,
    });
    await applyBlob(
      {
        transcription: { exportMedia: "gif", exportContainer: "avi", exportSubtitleMode: 3 } as never,
        fileTranscriptions: { keepUrlVideoCopies: "yes", urlVideoMaxHeight: "tall" } as never,
      },
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().settings.transcribe).toMatchObject({
      exportMedia: "audio", exportContainer: "mkv", exportSubtitleMode: "sidecar",
      keepUrlVideoCopies: false, urlVideoMaxHeight: 1080,
    });
    await applyBlob({ fileTranscriptions: { urlVideoMaxHeight: null } }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.urlVideoMaxHeight).toBeNull();
  });

  it("an explicit restore applies machine-specific settings the sync switches would gate", async () => {
    // Chip position's switch is OFF on a stock install; a backup must still restore it.
    useApp.setState({ settings: settings() });
    await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL);
    expect(useApp.getState().settings.recording.indicatorPosition).toBe("top"); // sync round: gated
    await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL, 2, { ignoreGates: true });
    expect(useApp.getState().settings.recording.indicatorPosition).toBe("bottom"); // restore: applied
  });

  it("a pulled translation-model pick applies only with the Transcribe-picks switch", async () => {
    // Off on a stock install: a peer's per-server pick must not land under this device's own
    // backend, and a peer's backend switch ("") must not wipe this device's pick.
    const st0 = settings();
    st0.transcribe = { backendId: "b1", translationModel: "mine" };
    useApp.setState({ settings: st0 });
    await applyBlob(
      { transcription: { translationModel: "peer-m", translationMode: "faithful" } as never },
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("mine");
    expect(useApp.getState().settings.transcribe?.translationMode).toBe("faithful");
    await applyBlob({ transcription: { translationModel: "" } as never }, { ...CATS_ALL, backends: false });
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("mine");
    await applyBlob(
      { transcription: { translationModel: "peer-m" } as never },
      { ...CATS_ALL, backends: false },
      2,
      { ignoreGates: true },
    );
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("peer-m");
  });

  it("with the Transcribe-picks switch on, a translation-model pick applies only beside its backendId", async () => {
    // A pre-upgrade blob with no backendId carries translationModel alone: a model meant for
    // another server must not land under this device's backend.
    const st0 = settings();
    st0.transcribe = { backendId: "b1", translationModel: "mine" };
    st0.sync = { ...st0.sync, sub: { ...st0.sync?.sub, transcribePicks: true } } as AppSettings["sync"];
    useApp.setState({ settings: st0 });
    const cats = { ...CATS_ALL, backends: false };
    await applyBlob({ transcription: { translationModel: "peer-m" } as never }, cats);
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("mine");
    await applyBlob({ transcription: { translationModel: "" } as never }, cats);
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("mine");
    await applyBlob({ transcription: { backendId: "b2", translationModel: "peer-m" } as never }, cats);
    expect(useApp.getState().settings.transcribe?.backendId).toBe("b2");
    expect(useApp.getState().settings.transcribe?.translationModel).toBe("peer-m");
  });

  it("a pulled backend pick clears the picks its blob does not carry (the language follows the Backend)", async () => {
    // A peer's backend pick stores language undefined, which JSON drops: merged over, this
    // device's old backend's language would stay pinned under the new backend and push back.
    const st0 = settings();
    st0.transcribe = { backendId: "bX", model: "m", language: "de", translationModel: "t" };
    useApp.setState({ settings: st0 });
    await applyBlob(
      { transcription: { backendId: "bY", model: "", translationModel: "" } as never },
      CATS_ALL,
      2,
      { ignoreGates: true },
    );
    const tr = useApp.getState().settings.transcribe;
    expect(tr?.backendId).toBe("bY");
    expect(tr?.model).toBe("");
    expect(tr && "language" in tr).toBe(false);
    // Carried but malformed: dropped by the sanitizer, the local pick stands.
    useApp.setState({ settings: { ...settings(), transcribe: { backendId: "bX", language: "de" } } });
    await applyBlob({ transcription: { backendId: "bY", language: 7 } as never }, CATS_ALL, 2, { ignoreGates: true });
    expect(useApp.getState().settings.transcribe?.language).toBe("de");
    // No backendId in the blob: nothing to clear against, the local picks stand.
    useApp.setState({ settings: { ...settings(), transcribe: { backendId: "bX", language: "de" } } });
    await applyBlob({ transcription: { model: "x" } as never }, CATS_ALL, 2, { ignoreGates: true });
    expect(useApp.getState().settings.transcribe?.language).toBe("de");
  });

  it("an explicit restore also brings the folders and Transcribe picks the legacy sub keys gate", async () => {
    // These arms used to read `sub` directly, which ignoreGates never neutralised —
    // the very folders the restore comment promises were still dropped.
    useApp.setState({ settings: settings() });
    await applyBlob(
      {
        recording: { recordingsDir: "/tmp/x", audioBaseDir: "/tmp/y" } as never,
        transcription: { backendId: "b1", model: "m", language: "en" } as never,
      },
      CATS_ALL,
      2,
      { ignoreGates: true },
    );
    const st = useApp.getState().settings;
    expect(st.recording.recordingsDir).toBe("/tmp/x");
    expect(st.recording.audioBaseDir).toBe("/tmp/y");
    expect(st.transcribe?.backendId).toBe("b1");
    expect(st.transcribe?.model).toBe("m");
    expect(st.transcribe?.language).toBe("en");
  });

  it("an absent dictationRetentionDays on the wire is 'no change', not the 7-day default", () => {
    const local = { recording: { dictationRetentionDays: 30 } } as never;
    expect(
      securityChanges({ recording: { saveRecordings: true } } as never, local, CATS_ALL).some(
        (c) => c.kind === "dictation-retention",
      ),
    ).toBe(false);
    expect(
      securityChanges({ recording: { dictationRetentionDays: 7 } } as never, local, CATS_ALL).some(
        (c) => c.kind === "dictation-retention",
      ),
    ).toBe(true);
  });

  it("a non-numeric dictationRetentionDays on the wire is 'no change' — the apply side drops it", () => {
    const local = { recording: { dictationRetentionDays: 30 } } as never;
    for (const bad of [null, "7", Number.NaN]) {
      expect(
        securityChanges({ recording: { dictationRetentionDays: bad } } as never, local, CATS_ALL).some(
          (c) => c.kind === "dictation-retention",
        ),
      ).toBe(false);
    }
  });

  // The apply rounds/clamps the two transcription-settings clocks to 0..3650 and drops a
  // non-u32 recordingsRetentionDays; the review must judge that same value, or it asks consent
  // for a deletion window that never applies.
  it("retention days are judged as the apply normalizes them", () => {
    const local = { recording: { dictationRetentionDays: 30 } } as never;
    const dictChange = (incoming: Record<string, unknown>) =>
      securityChanges({ recording: incoming } as never, local, CATS_ALL).find(
        (c) => c.kind === "dictation-retention",
      );
    expect(dictChange({ dictationRetentionDays: -1 })).toBeUndefined(); // clamps to 0 = off
    expect(dictChange({ dictationRetentionDays: 0.3 })).toBeUndefined(); // rounds to 0 = off
    expect(dictChange({ recordingsRetentionDays: 2.5 })).toBeUndefined(); // not a u32: dropped
    expect(dictChange({ recordingsRetentionDays: -3 })).toBeUndefined();
    expect(dictChange({ dictationRetentionDays: 6.6 })?.detail).toContain("after 7 days instead of 30");
    const fileLocal = { fileTranscriptions: { historyRetentionDays: 30 } } as never;
    const fileChange = (v: unknown) =>
      securityChanges({ fileTranscriptions: { historyRetentionDays: v } } as never, fileLocal, CATS_ALL).some(
        (c) => c.kind === "history-retention",
      );
    expect(fileChange(-5)).toBe(false);
    expect(fileChange(0.4)).toBe(false);
    expect(fileChange(undefined)).toBe(false); // absent key: no change
    expect(fileChange(9)).toBe(true);
  });

  it("the Pinned word mappings switch gates the pin on apply", async () => {
    const base = settings();
    useApp.setState({
      settings: {
        ...base,
        sync: { ...base.sync, sub: { ...base.sync?.sub, pinnedMappings: false } },
      } as unknown as AppSettings,
      backends: [backend()],
    });
    const before = useApp.getState().settings.quickAddList;
    await applyBlob(
      {
        backends: { list: [backend()] } as never,
        dictionary: { quickAddList: { backendId: "b1", slug: "x" } } as never,
      },
      CATS_ALL,
    );
    expect(useApp.getState().settings.quickAddList).toEqual(before);
  });

  it("dictation-history flags survive a blob that also carries the transcription category", async () => {
    // The recording arm routes them into settings.transcribe; the transcription arm then
    // rebuilt transcribe from the PRE-apply settings and threw them away — on every pull.
    useApp.setState({ settings: settings() });
    await applyBlob(
      {
        recording: { keepDictationHistory: true, dictationRetentionDays: 5 } as never,
        transcription: { translationMode: "faithful" } as never,
      },
      CATS_ALL,
    );
    const t = useApp.getState().settings.transcribe;
    expect(t?.dictationRetentionDays).toBe(5);
    expect(t?.translationMode).toBe("faithful");
  });

  it("typeAsISpeak travels in the general block", async () => {
    // It replaced `insertTiming` as the global default every inheriting Profile resolves
    // through; the manifest offers a sync switch for it, so the wire must carry it.
    const cfg = slice();
    cfg.settings.general.typeAsISpeak = false;
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.general?.typeAsISpeak).toBe(false);
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

  it("excludeFromClipboardHistory travels in the general block and applies", async () => {
    // Not machine-specific: a user who wants dictated text out of clipboard history wants it
    // on every device, so it composes like restoreClipboard and applies like it.
    const cfg = slice();
    cfg.settings.general.excludeFromClipboardHistory = false;
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    expect(blob.general?.excludeFromClipboardHistory).toBe(false);

    useApp.setState({ settings: settings(), appRules: [] });
    expect(useApp.getState().settings.general.excludeFromClipboardHistory).toBe(true);
    await applyBlob({ general: { excludeFromClipboardHistory: false } }, { ...CATS_ALL, backends: false, profiles: false });
    expect(useApp.getState().settings.general.excludeFromClipboardHistory).toBe(false);
  });

  it("a blob written before excludeFromClipboardHistory existed keeps the local value", async () => {
    useApp.setState({ settings: settings(), appRules: [] });
    await applyBlob({ general: { soundEffects: false } }, { ...CATS_ALL, backends: false, profiles: false });
    expect(useApp.getState().settings.general.excludeFromClipboardHistory).toBe(true);
  });

  it("an app rule's remoteDesktop is clamped to true / false / null, junk dropped to auto", async () => {
    useApp.setState({ settings: settings(), appRules: [] });
    const bucket = IS_WINDOWS ? "windows" : "linux";
    await applyBlob(
      {
        appRules: {
          [bucket]: [
            { id: "a", appId: "mstsc", block: false, remoteDesktop: true },
            { id: "b", appId: "anydesk", block: false, remoteDesktop: false },
            { id: "c", appId: "citrix", block: false, remoteDesktop: null },
            { id: "d", appId: "vncviewer", block: false, remoteDesktop: "yes" },
            { id: "e", appId: "konsole", block: false },
          ],
        } as never,
      },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const by = (id: string) => useApp.getState().appRules.find((x) => x.id === id)!;
    expect(by("a").remoteDesktop).toBe(true);
    expect(by("b").remoteDesktop).toBe(false);
    expect(by("c").remoteDesktop).toBeNull();
    // A truthy string must never force the remote path — it reads as auto (unset).
    expect(by("d").remoteDesktop ?? null).toBeNull();
    expect(by("e").remoteDesktop ?? null).toBeNull();
  });

  it("an app rule's remoteDesktop composes into this OS's bucket", async () => {
    const cfg = {
      ...slice(),
      appRules: [{ id: "r1", appId: "mstsc", block: false, remoteDesktop: false }] as never[],
    };
    const blob = await composeBlob(cfg, CATS_ALL, undefined, { includeSecrets: false, sub: LEGACY_SUB });
    const mine = blob.appRules![IS_WINDOWS ? "windows" : "linux"][0] as unknown as Record<string, unknown>;
    expect(mine.remoteDesktop).toBe(false);
  });

  it("a malformed category container is skipped whole, never spread", async () => {
    // `"backends": []` / a string / a number are all truthy: without the isPlainObject
    // guard `sanitizeBackends(undefined)` returned [] and the dangling-reference scrub
    // then read that as "every profile's backend is gone".
    useApp.setState({ profiles: [profile({ activation: "hold" })] }); // "toggle" is not a valid kind
    const before = useApp.getState();
    await applyBlob(
      { backends: [] as never, profiles: "x" as never, appRules: 5 as never },
      CATS_ALL,
    );
    const after = useApp.getState();
    expect(after.backends).toEqual(before.backends);
    expect(after.profiles).toEqual(before.profiles);
    expect(after.appRules).toEqual(before.appRules);
    expect(after.settings.quickAddList).toEqual(before.settings.quickAddList);
  });

  it("a malformed profiles container does not count as inbound for the quick-add collision", async () => {
    // The profiles arm skips a truthy non-object, so the list is still THIS device's own — a
    // remote chord colliding with it must be dropped, not switch the local profile off.
    useApp.setState({ profiles: [profile({ hotkey: ["ControlLeft", "KeyX"] })] });
    const before = useApp.getState().settings.general.quickAddHotkey;
    await applyBlob(
      { profiles: "x" as never, dictionary: { quickAddHotkey: ["ControlLeft"] } as never },
      CATS_ALL,
    );
    const after = useApp.getState();
    expect(after.profiles[0].enabled).toBe(true);
    expect(after.settings.general.quickAddHotkey).toEqual(before);
  });

  it("the import/restore preview's collision prediction is what applyBlob installs", async () => {
    // The Sync tab's previews call `disableConflictingProfiles` on the would-be state; it once
    // ran its own `conflicts()` and warned of a save freeze the apply never leaves behind.
    const inbound = [
      profile({ id: "p1", hotkey: ["ControlLeft", "Space"] }),
      profile({ id: "p2", hotkey: ["ControlRight", "Space"] }), // an L/R-only pair
      profile({ id: "p3", hotkey: ["ControlLeft", "KeyQ"] }),
    ];
    const qa = useApp.getState().settings.general.quickAddHotkey;
    const predicted = disableConflictingProfiles(sanitizeProfiles(inbound), qa, true);
    await applyBlob({ profiles: { list: inbound } } as never, CATS_ALL);
    const enabled = (ps: Profile[]) => ps.map((p) => [p.id, p.enabled !== false]);
    expect(enabled(useApp.getState().profiles)).toEqual(enabled(predicted.profiles));
    // Off Windows the registrar collapses sides, so the later member is switched off.
    expect(predicted.profiles[1].enabled).toBe(IS_WINDOWS);
    // A dictionary-only chord against this device's own profiles: the chord is dropped instead.
    useApp.setState({ profiles: [profile({ hotkey: ["ControlLeft", "KeyX"] })] });
    const local = useApp.getState();
    const chord = disableConflictingProfiles(local.profiles, ["ControlLeft"], false);
    expect(chord.rejectQuickAddHotkey).toBe(true);
    expect(chord.profiles[0].enabled).toBe(true);
    await applyBlob({ dictionary: { quickAddHotkey: ["ControlLeft"] } } as never, CATS_ALL);
    expect(useApp.getState().settings.general.quickAddHotkey).toEqual(local.settings.general.quickAddHotkey);
  });

  it("a store edit made while the keyring wait is parked is not hydrated away", async () => {
    // Everything applyBlob computes is derived from a PRE-wait snapshot, and hydrate replaces
    // the slices wholesale — so the staleness check must cover `backends` too, not just
    // `settings` (upsertBackend returns only `{backends}`). Retries exhausted → drop the
    // apply; the next pull re-offers it.
    let release: (v: Record<string, string>) => void = () => {};
    keyring.park = new Promise((r) => (release = r));
    try {
      const applying = applyBlob(
        { backends: { list: [backend({ name: "from-peer" })] } },
        { ...CATS_ALL, profiles: false },
        0,
      );
      await Promise.resolve();
      useApp.getState().upsertBackend(backend({ id: "b2", name: "added-meanwhile" }));
      release({});
      expect(await applying).toBe(false); // dropped stale, nothing hydrated
    } finally {
      keyring.park = null;
    }
    const byId = new Map(useApp.getState().backends.map((b) => [b.id, b]));
    expect(byId.get("b2")?.name).toBe("added-meanwhile"); // the user's edit survived
    expect(byId.get("b1")!.name).toBe("local"); // and the blob did not land
  });

  it("a session started during the keyring wait reports 'not applied' and parks nothing", async () => {
    // The stale-restart retry re-entered applyBlob's top-of-function "dictation live" branch and
    // parked the blob (now: a re-pull) — so a one-shot caller (import, restore, review approval)
    // was told "not applied" while the settings landed anyway once the session ended.
    rejectPendingReview(); // drops the apply the "defers while dictation is live" test parked
    expect(hasPendingApplyForTests()).toBe(false);
    let release: (v: Record<string, string>) => void = () => {};
    keyring.park = new Promise((r) => (release = r));
    try {
      const applying = applyBlob(
        { backends: { list: [backend({ name: "from-peer" })] } },
        { ...CATS_ALL, profiles: false },
      );
      await Promise.resolve();
      useApp.setState({ status: "recording" as never });
      release({});
      expect(await applying).toBe(false);
    } finally {
      keyring.park = null;
      useApp.setState({ status: "idle" });
    }
    expect(hasPendingApplyForTests()).toBe(false); // nothing queued to land behind the UI
    expect(useApp.getState().backends[0].name).toBe("local");
  });

  it("side-differing inbound chords are only collapsed where the registrar collapses them", async () => {
    // The sanitizer calls `conflicts(peers, !IS_WINDOWS)` and switches the later member of
    // each collision off. Windows' low-level hook registers LCtrl+Space and RCtrl+Space as
    // distinct chords, so collapsing there disabled a WORKING pair on every pull.
    useApp.setState({ settings: settings(), profiles: [] });
    await applyBlob(
      {
        profiles: {
          list: [
            profile({ id: "p1", activation: "hold", hotkey: ["ControlLeft", "Space"] }),
            profile({ id: "p2", activation: "hold", hotkey: ["ControlRight", "Space"] }),
          ],
          homeProfileId: null,
        },
      },
      { ...CATS_ALL, backends: false },
    );
    const byId = new Map(useApp.getState().profiles.map((p) => [p.id, p]));
    expect(byId.get("p1")!.enabled).toBe(true);
    expect(byId.get("p2")!.enabled).toBe(IS_WINDOWS);
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

  it("a wrong-typed recording leaf raises no review (it would never apply)", () => {
    // securityChanges runs on the merged blob BEFORE applyBlob's typed pass. A string "3" or
    // a truthy non-bool must not park the whole recording category for a no-op change.
    const local = { recording: { recordingsRetentionDays: 0, saveRecordings: false } } as never;
    expect(
      securityChanges(
        { recording: { recordingsRetentionDays: "3", saveRecordings: "yes" } } as never,
        local,
        CATS_ALL,
      ).filter((c) => c.kind.endsWith("-retention") || c.kind === "save-recordings"),
    ).toEqual([]);
    // The typed input still raises both (the audio window shortens the one dictation clock).
    expect(
      securityChanges(
        { recording: { recordingsRetentionDays: 3, saveRecordings: true } } as never,
        local,
        CATS_ALL,
      ).map((c) => c.kind).sort(),
    ).toEqual(["dictation-retention", "save-recordings"]);
  });

  it("the two dictation retention keys are judged as the one effective clock", () => {
    const retention = (c: { kind: string }) => c.kind.endsWith("-retention");
    // Audio 0 + record 7 (effective 7) → 30/30 lengthens the window: nothing is deleted sooner.
    expect(
      securityChanges(
        { recording: { recordingsRetentionDays: 30, dictationRetentionDays: 30 } } as never,
        { recording: { recordingsRetentionDays: 0 } } as never,
        CATS_ALL,
      ).filter(retention),
    ).toEqual([]);
    // Both 0 (kept forever) → audio 3: dictations start being deleted.
    expect(
      securityChanges(
        { recording: { recordingsRetentionDays: 3 } } as never,
        { recording: { recordingsRetentionDays: 0, dictationRetentionDays: 0 } } as never,
        CATS_ALL,
      ).filter(retention).map((c) => c.kind),
    ).toEqual(["dictation-retention"]);
  });

  it("a gated-off server address or API key raises no review (the apply would re-pin it)", () => {
    const local = {
      backends: { list: [{ id: "b1", name: "Home", serverUrl: "http://a:8000" }], secrets: { b1: "old" } },
    } as never;
    const incoming = {
      backends: { list: [{ id: "b1", name: "Home", serverUrl: "http://b:8000" }], secrets: { b1: "new" } },
    } as never;
    const kinds = (g?: { serverAddresses?: boolean; apiKeys?: boolean }) =>
      securityChanges(incoming, local, CATS_ALL, g as never).map((c) => c.kind).sort();
    expect(kinds()).toEqual(["api-key", "server-url"]);
    expect(kinds({ serverAddresses: false })).toEqual(["api-key"]);
    expect(kinds({ apiKeys: false })).toEqual(["server-url"]);
    // A backend new to this device keeps its inbound address regardless of the gate.
    expect(
      securityChanges(incoming, { backends: { list: [], secrets: {} } } as never, CATS_ALL, {
        serverAddresses: false,
        apiKeys: false,
      } as never).map((c) => c.kind),
    ).toEqual(["new-backend"]);
  });

  it("a NEW backend's typed text is held even while decode defaults don't sync", () => {
    // applyBlob re-pins only a backend this device knows; a new one keeps its inbound overrides.
    const incoming = {
      backends: {
        list: [{ id: "b9", name: "Peer", serverUrl: "http://p:8000", decodeOverrides: { output_suffix: "!" } }],
        secrets: {},
      },
    } as never;
    const changes = securityChanges(incoming, { backends: { list: [], secrets: {} } } as never, CATS_ALL, {
      modelDecodeDefaults: false,
    } as never);
    expect(changes.map((c) => [c.kind, c.category ?? ""])).toEqual([
      ["typed-text", "backends"],
      ["new-backend", ""],
    ]);
    // A known backend's text still raises nothing with the gate off (the apply re-pins it).
    const known = { backends: { list: [{ id: "b9", name: "Peer", serverUrl: "http://p:8000" }], secrets: {} } } as never;
    expect(securityChanges(incoming, known, CATS_ALL, { modelDecodeDefaults: false } as never)).toEqual([]);
  });

  it("typed text on an entry the apply drops raises no review", () => {
    const typed = (c: { kind: string }) => c.kind === "typed-text";
    const text = { output_suffix: "!" };
    // A non-string serverUrl and a reserved id: `sanitizeBackends` drops both, so the text never lands.
    const backends = {
      backends: {
        list: [
          { id: "b9", name: "Peer", serverUrl: 5, decodeOverrides: text },
          { id: "__x__", name: "Peer", serverUrl: "http://p:8000", decodeOverrides: text },
        ],
        secrets: {},
      },
    } as never;
    const empty = { backends: { list: [], secrets: {} } } as never;
    for (const g of [undefined, { modelDecodeDefaults: false }])
      expect(securityChanges(backends, empty, CATS_ALL, g as never).filter(typed)).toEqual([]);
    // A duplicate id's second copy is dropped too (first wins).
    const dupe = {
      backends: {
        list: [
          { id: "b9", name: "Peer", serverUrl: "http://p:8000" },
          { id: "b9", name: "Peer", serverUrl: "http://p:8000", decodeOverrides: text },
        ],
        secrets: {},
      },
    } as never;
    for (const g of [undefined, { modelDecodeDefaults: false }])
      expect(securityChanges(dupe, empty, CATS_ALL, g as never).filter(typed)).toEqual([]);
    // Profiles: a non-string name, a non-code-list hotkey and a duplicate id are all dropped.
    const profiles = {
      profiles: {
        list: [
          { ...profile({ id: "p8" }), name: 5, decodeOverrides: text },
          { ...profile({ id: "p7" }), hotkey: [1], decodeOverrides: text },
          profile({ id: "p6" }),
          profile({ id: "p6", decodeOverrides: text }),
        ],
      },
    } as never;
    expect(
      securityChanges(profiles, { profiles: { list: [] } } as never, CATS_ALL).filter(typed),
    ).toEqual([]);
    // The kept entry's text is still held.
    expect(
      securityChanges(
        { profiles: { list: [profile({ id: "p6", decodeOverrides: text })] } } as never,
        { profiles: { list: [] } } as never,
        CATS_ALL,
      ).filter(typed),
    ).toHaveLength(1);
  });

  it("a consent row for a name that renders blank says 'Untitled' or the address, never blank or an id", () => {
    const text = { output_prefix: ">" };
    // Profiles: a blank, a spaces-only and a joiner-only name read as the label the lists show.
    for (const name of ["", "   ", "\u2800\u2800", "\u200d", "\u200c "]) {
      const rows = securityChanges(
        { profiles: { list: [profile({ id: "p6", name, decodeOverrides: text })] } } as never,
        { profiles: { list: [] } } as never,
        CATS_ALL,
      ).filter((c) => c.kind === "typed-text");
      expect(rows.map((c) => c.backend)).toEqual(["Untitled profile"]);
    }
    // Backends: a known one whose name renders blank is named by its address on the api-key row…
    const blank = [{ id: "b1", name: "\u2800\u2800", serverUrl: "http://p:8000" }];
    const keyRow = securityChanges(
      { backends: { list: blank, secrets: { b1: "sk-1" } } } as never,
      { backends: { list: blank, secrets: {} } } as never,
      CATS_ALL,
    ).filter((c) => c.kind === "api-key");
    expect(keyRow.map((c) => c.backend)).toEqual(["http://p:8000"]);
    // …and one named only by a joiner on the server-url row (a leading joiner joins nothing).
    const joiner = (serverUrl: string) => [{ id: "b1", name: "\u200d", serverUrl }];
    const urlRow = securityChanges(
      { backends: { list: joiner("http://q:8000"), secrets: {} } } as never,
      { backends: { list: joiner("http://p:8000"), secrets: {} } } as never,
      CATS_ALL,
    ).filter((c) => c.kind === "server-url");
    expect(urlRow.map((c) => c.backend)).toEqual(["http://p:8000"]);
    // Two blank-named profiles share a label but stay two rows: each carries its own id, which
    // is part of the review identity (a second one arriving later re-raises the review).
    const two = securityChanges(
      { profiles: { list: [profile({ id: "p6", name: "", decodeOverrides: text }), profile({ id: "p7", name: " ", decodeOverrides: text })] } } as never,
      { profiles: { list: [] } } as never,
      CATS_ALL,
    ).filter((c) => c.kind === "typed-text");
    expect(two.map((c) => [c.id, c.backend])).toEqual([["p6", "Untitled profile"], ["p7", "Untitled profile"]]);
    // …and a visible name is still kept verbatim.
    const named = [{ id: "b1", name: "Home", serverUrl: "http://p:8000" }];
    expect(
      securityChanges(
        { backends: { list: named, secrets: { b1: "sk-1" } } } as never,
        { backends: { list: named, secrets: {} } } as never,
        CATS_ALL,
      ).map((c) => c.backend),
    ).toEqual(["Home"]);
  });

  it("a known entry's consent rows are all labelled from this device's copy, not the peer's", () => {
    const text = { output_prefix: ">" };
    // (1) A peer renames a known backend and also sets typed text and a new key: one backend,
    // one label, on every row of the dialog.
    const renamed = securityChanges(
      {
        backends: {
          list: [{ id: "b1", name: "Peer name", serverUrl: "http://p:8000", decodeOverrides: text }],
          secrets: { b1: "sk-new" },
        },
      } as never,
      { backends: { list: [{ id: "b1", name: "Home", serverUrl: "http://p:8000" }], secrets: { b1: "sk-old" } } } as never,
      CATS_ALL,
    );
    expect(renamed.map((c) => [c.kind, c.backend])).toEqual([
      ["typed-text", "Home"],
      ["api-key", "Home"],
    ]);
    // (2) A known backend with a blank local name, repointed under a peer name: its own address,
    // not the peer's name and not the address it would move to.
    const repointed = securityChanges(
      { backends: { list: [{ id: "b1", name: "Home", serverUrl: "http://evil:8000" }], secrets: {} } } as never,
      { backends: { list: [{ id: "b1", name: "  ", serverUrl: "http://p:8000" }], secrets: {} } } as never,
      CATS_ALL,
    );
    expect(repointed.map((c) => [c.kind, c.backend])).toEqual([["server-url", "http://p:8000"]]);
    // (3) A known named profile the peer blanks while setting an output prefix keeps its name.
    const blanked = securityChanges(
      { profiles: { list: [profile({ id: "p6", name: "", decodeOverrides: text })] } } as never,
      { profiles: { list: [profile({ id: "p6", name: "Work" })] } } as never,
      CATS_ALL,
    ).filter((c) => c.kind === "typed-text");
    expect(blanked.map((c) => c.backend)).toEqual(["Work"]);
  });

  it("server rows judge the backends the apply installs, not the raw list", () => {
    const changes = (list: unknown[], localList: unknown[], secrets: unknown = {}) =>
      securityChanges(
        { backends: { list, secrets } } as never,
        { backends: { list: localList, secrets: {} } } as never,
        CATS_ALL,
      );
    const rows = (list: unknown[], localList: unknown[], secrets: unknown = {}) =>
      changes(list, localList, secrets).map((c) => [c.kind, c.url ?? ""]);
    // (a) A reserved id is dropped by the apply: no new-backend row, no key row.
    expect(rows([{ id: "__x__", name: "Peer", serverUrl: "http://p:8000" }], [], { __x__: "k" })).toEqual([]);
    // (b) A duplicate id: only the FIRST copy lands, so one row naming its address.
    expect(
      rows(
        [
          { id: "b9", name: "Peer", serverUrl: "http://p:8000" },
          { id: "b9", name: "Peer", serverUrl: "http://evil:8000" },
        ],
        [],
      ),
    ).toEqual([["new-backend", "http://p:8000"]]);
    // (c) A known backend's dropped second copy cannot repoint it.
    const known = [{ id: "b1", name: "Home", serverUrl: "http://p:8000" }];
    expect(
      rows(
        [
          { id: "b1", name: "Home", serverUrl: "http://p:8000" },
          { id: "b1", name: "Home", serverUrl: "http://evil:8000" },
        ],
        known,
      ),
    ).toEqual([]);
    // (d) An unsupported scheme is stored blank: the row names the blank value…
    expect(rows([{ id: "b1", name: "Home", serverUrl: "ftp://h" }], known)).toEqual([["server-url", ""]]);
    // …and says the address would be cleared rather than rendering a blank target.
    expect(changes([{ id: "b1", name: "Home", serverUrl: "ftp://h" }], known)[0].detail).toBe(
      "http://p:8000 → (none: the address would be cleared)",
    );
    expect(changes([{ id: "b2", name: "Peer", serverUrl: "ftp://h" }], known)[0]).toMatchObject({
      kind: "new-backend",
      detail: "(no address)",
      url: "",
    });
    // …and nothing changes when the local address is already blank.
    expect(rows([{ id: "b1", name: "Home", serverUrl: "ftp://h" }], [{ ...known[0], serverUrl: "" }])).toEqual([]);
    // A known backend stored blank that a peer repoints names the blank source too.
    expect(
      changes([{ id: "b1", name: "Home", serverUrl: "http://h:1" }], [{ ...known[0], serverUrl: "" }])[0].detail,
    ).toBe("(no address) → http://h:1");
  });

  it("an api-key row needs a key the apply would actually write", () => {
    const known = [{ id: "b1", name: "Home", serverUrl: "http://p:8000" }];
    const keyRows = (list: unknown[], secrets: unknown) =>
      securityChanges(
        { backends: { list, secrets } } as never,
        { backends: { list, secrets: {} } } as never,
        CATS_ALL,
      ).filter((c) => c.kind === "api-key");
    // A non-string value: `reconcileBackendSecrets` writes nothing for it.
    expect(keyRows(known, { b1: 5 })).toEqual([]);
    // A string container: own-property reads index it per code unit, so id "0" found "a".
    expect(keyRows([{ id: "0", name: "Zero", serverUrl: "http://p:8000" }], "abc")).toEqual([]);
    // A real key still asks.
    expect(keyRows(known, { b1: "sk-1" })).toHaveLength(1);
  });

  it("sanitizeProfiles clamps decodeOverrides like its Backend twin", () => {
    const [junk, mixed] = sanitizeProfiles([
      profile({ id: "p1", decodeOverrides: "abc" as never }),
      profile({ id: "p2", decodeOverrides: { beam_size: 5, hotwords: "x", nested: {} } as never }),
    ]);
    expect(junk.decodeOverrides).toBeUndefined();
    expect(mixed.decodeOverrides).toEqual({ beam_size: 5, hotwords: "x" });
  });

  it("a timed-out keyring read-back keeps the local hasApiKey flag instead of demoting", async () => {
    // A degraded read re-derived `hasApiKey: false` for every backend, which the next push
    // took as "no backend claims a key" — bypassing composeBlob's erase guard.
    vi.useFakeTimers();
    keyring.park = new Promise(() => {}); // never settles: the locked-wallet case
    try {
      useApp.setState({ settings: settings(), backends: [backend({ hasApiKey: true })] });
      const applying = applyBlob(
        { backends: { list: [backend({ hasApiKey: true, name: "from-peer" })] } },
        { ...CATS_ALL, profiles: false },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await applying).toBe(true);
    } finally {
      keyring.park = null;
      vi.useRealTimers();
    }
    const b1 = useApp.getState().backends.find((b) => b.id === "b1")!;
    expect(b1.name).toBe("from-peer"); // the blob landed
    expect(b1.hasApiKey).toBe(true); // but the degraded read did not demote the flag
  });
});

// A key rotated on another device keeps the backend's serverUrl and hasApiKey, so hydrate's own
// eviction never fired: the caps and connection measured as the OLD caller stayed live.
describe("applyBlob evicts a backend whose API key the pull rotated", () => {
  const caps = { b1: { kind: "full" } } as never;
  const pull = (secret: string) =>
    applyBlob({ backends: { list: [backend({ hasApiKey: true })], secrets: { b1: secret } } }, CATS_ALL);

  beforeEach(() => {
    useApp.setState({
      settings: settings(),
      backends: [backend({ hasApiKey: true })],
      profiles: [profile()],
      appRules: [],
      status: "idle",
      caps,
    });
  });

  it("a different key drops the cached caps", async () => {
    keyring.keys = { b1: "sk-old" };
    try {
      expect(await pull("sk-new")).toBe(true);
    } finally {
      keyring.keys = null;
    }
    expect(useApp.getState().caps.b1).toBeUndefined();
  });

  it("an apply dropped stale after the key write still drops them", async () => {
    // The keyring already holds the new key once the write lands, so a STALE restart (or a
    // dropped apply) reads prior == incoming and finds nothing rotated: evicting only after the
    // hydrate lost the eviction for good.
    let release: (v: Record<string, string>) => void = () => {};
    keyring.park = new Promise((r) => (release = r));
    try {
      const applying = applyBlob(
        { backends: { list: [backend({ hasApiKey: true })], secrets: { b1: "sk-new" } } },
        CATS_ALL,
        0,
      );
      await Promise.resolve();
      useApp.getState().upsertBackend(backend({ id: "b2", name: "added-meanwhile" }));
      keyring.park = null;
      keyring.keys = { b1: "sk-new" };
      release({ b1: "sk-old" });
      expect(await applying).toBe(false); // dropped stale
    } finally {
      keyring.park = null;
      keyring.keys = null;
    }
    expect(useApp.getState().caps.b1).toBeUndefined();
  });

  it("the same key rewritten keeps them", async () => {
    keyring.keys = { b1: "sk-old" };
    try {
      expect(await pull("sk-old")).toBe(true);
    } finally {
      keyring.keys = null;
    }
    expect(useApp.getState().caps.b1).toBeDefined();
  });

  // A key ADDED to a keyless backend replaces no stored key, yet the backend's caller changed:
  // without a generation move, the editor's blank-key verdict and the generation-keyed fetches
  // (decode defaults, override context) kept the anonymous caller's answers.
  it("a key added to a keyless backend moves its credential generation", async () => {
    useApp.setState({ backends: [backend({ hasApiKey: false })] });
    const gen0 = credentialGeneration("b1");
    keyring.store = new Map();
    try {
      expect(await applyBlob({ backends: { list: [backend({ hasApiKey: false })], secrets: { b1: "sk-new" } } }, CATS_ALL)).toBe(true);
    } finally {
      keyring.store = null;
    }
    expect(credentialGeneration("b1")).toBe(gen0 + 1);
    expect(useApp.getState().backends[0].hasApiKey).toBe(true);
    expect(useApp.getState().caps.b1).toBeUndefined();
  });

  it("a degraded keyring read moves nothing", async () => {
    useApp.setState({ backends: [backend({ hasApiKey: false })] });
    const gen0 = credentialGeneration("b1");
    keyring.park = Promise.resolve(null as unknown as Record<string, string>);
    try {
      expect(await applyBlob({ backends: { list: [backend({ hasApiKey: false })], secrets: { b1: "sk-new" } } }, CATS_ALL)).toBe(true);
    } finally {
      keyring.park = null;
    }
    expect(credentialGeneration("b1")).toBe(gen0);
    expect(useApp.getState().backends[0].hasApiKey).toBe(false);
    expect(useApp.getState().caps.b1).toBeDefined();
  });
});

// Builds before `persistState` narrowed its writer stashed a blank key as `{id: ""}` and recorded
// its id; counting that as missing latched the backends push refusal on every launch.
describe("restoreSnapshotSecrets reads the stash by the writer's rule", () => {
  const restore = async (stash: unknown, ids: string[]) => {
    keyring.keys = { __sync_snapshot_secrets__: JSON.stringify(stash) };
    try {
      return await restoreSnapshotSecretsForTests(ids);
    } finally {
      keyring.keys = null;
    }
  };
  afterEach(() => restoreSnapshotSecretsForTests([])); // clears the latch and the seeded state

  it("a legacy blank entry is skipped, not counted missing", async () => {
    expect(await restore({ a: "k", b: "" }, ["a", "b"])).toEqual({ blocked: false, restored: { a: "k" } });
    expect((await restore({ b: "" }, ["b"])).blocked).toBe(false);
  });

  it("a genuinely missing or unreadable key still blocks the pass-through", async () => {
    expect((await restore({ a: 5 }, ["a"])).blocked).toBe(true);
    expect((await restore({}, ["a"])).blocked).toBe(true); // locked wallet
    expect((await restore({ a: "k" }, ["a", "b"])).blocked).toBe(true); // partial read-back
    expect((await restore("ab", ["0"])).blocked).toBe(true); // string container
  });
});

// wincred refuses a credential over 2560 bytes (1280 UTF-16 units), and the whole stash went into
// one: about a dozen keyed backends failed the write on Windows while the ids persisted anyway, so
// the next launch latched the backends refusal — or restored an older stash's stale keys as the
// merge base.
describe("the snapshot key stash spans keyring accounts", () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const keys = (n: number, tag: string) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [uuid(i), `${tag}-${"k".repeat(44)}`.slice(0, 48)]));
  beforeEach(() => {
    keyring.store = new Map();
    keyring.failWrites = new Set();
    keyring.writes = [];
    keyring.parkWrites = new Map();
    keyring.deletes = [];
  });
  afterEach(async () => {
    keyring.store = null;
    keyring.failWrites = new Set();
    keyring.writes = [];
    keyring.parkWrites = new Map();
    keyring.deletes = [];
    await restoreSnapshotSecretsForTests([]); // clears the latch and the seeded state
  });

  it("a 20-backend stash round-trips with every account under the wincred limit", async () => {
    const secrets = keys(20, "sk");
    const { ids, chunks } = await persistSnapshotSecretsForTests(secrets);
    expect(chunks).toBeGreaterThan(1);
    expect(keyring.store!.size).toBe(chunks);
    for (const v of keyring.store!.values()) expect(v.length).toBeLessThanOrEqual(1280);
    expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: false, restored: secrets });
  });

  it("a one-chunk stash keeps the legacy single account, and a shrink drops the old tail", async () => {
    await persistSnapshotSecretsForTests(keys(20, "sk"));
    const small = keys(2, "sk");
    const { ids, chunks } = await persistSnapshotSecretsForTests(small);
    expect(chunks).toBeUndefined();
    expect([...keyring.store!.keys()]).toEqual(["__sync_snapshot_secrets__"]);
    expect(keyring.store!.get("__sync_snapshot_secrets__")).toBe(JSON.stringify(small));
    expect(await restoreSnapshotSecretsForTests(ids)).toEqual({ blocked: false, restored: small });
  });

  it("a failed chunk write latches the refusal instead of restoring the older stash", async () => {
    await persistSnapshotSecretsForTests(keys(2, "old"));
    keyring.failWrites.add("__sync_snapshot_secrets_1__");
    const { ids, chunks } = await persistSnapshotSecretsForTests(keys(20, "new"));
    // The failure drop is issued but not awaited (e59335c): wait for its deletes to land.
    await vi.waitFor(() => expect(keyring.store!.size).toBe(0));
    expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: true, restored: undefined });
  });

  // A backend id is its keyring account verbatim, and the sanitizers drop only `__…__` ids: a chunk
  // account outside that namespace let a peer's backend alias a slice of every key.
  it("every chunk account sits in the reserved namespace no synced backend id can take", async () => {
    const { chunks } = await persistSnapshotSecretsForTests(keys(20, "sk"));
    expect(chunks).toBeGreaterThan(1);
    for (const account of keyring.store!.keys()) {
      expect(account.startsWith("__") && account.endsWith("__")).toBe(true);
    }
    expect(sanitizeBackends([...keyring.store!.keys()].map((id) => backend({ id })))).toEqual([]);
    expect(
      sanitizeBackends([backend({ id: "__sync_snapshot_secrets_1__" }), backend({ id: "__sync_snapshot_secrets_2__" })]),
    ).toEqual([]);
  });

  // Rust runs keyring writes one at a time in arrival order: a chunk write issued only after the
  // previous one landed queued BEHIND a reset's delete issued meanwhile, and landed with nothing
  // left to remove it.
  it("issues every chunk write at once, before the first one lands", async () => {
    let release!: () => void;
    keyring.parkWrites.set("__sync_snapshot_secrets__", new Promise<void>((r) => (release = r)));
    const pending = persistSnapshotSecretsForTests(keys(20, "sk"));
    await Promise.resolve();
    const issued = [...keyring.writes];
    release();
    const { chunks } = await pending;
    expect(chunks).toBeGreaterThan(1);
    expect(issued).toHaveLength(chunks!);
    expect(keyring.store!.size).toBe(chunks);
  });

  // Issued together, a later chunk's bound also covers its wait behind the earlier ones (a wallet
  // prompt answered late): a flat 10 s each dropped a stash that one-after-another writes kept. The
  // mock runs writes in parallel, so parking chunk 1 for 15 s stands in for its wait behind chunk 0
  // on the Rust keyring lock.
  it("chunk i's write bound grows with its place (10 s x (i + 1))", async () => {
    vi.useFakeTimers();
    try {
      keyring.parkWrites.set("__sync_snapshot_secrets_1__", new Promise<void>((r) => setTimeout(r, 15_000)));
      const pending = persistSnapshotSecretsForTests(keys(20, "sk"));
      await vi.advanceTimersByTimeAsync(16_000);
      const { ids, chunks } = await pending;
      expect(chunks).toBeGreaterThan(1);
      expect(keyring.store!.size).toBe(chunks);
      expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: false, restored: keys(20, "sk") });
    } finally {
      vi.useRealTimers();
    }
  });

  // Rust's keyring lock is FIFO: behind a chunk-0 write parked on a locked wallet, no later chunk
  // lands either, and neither does the failure drop. Waiting out every chunk's bound kept the sync
  // parked 10 s per chunk although chunk 0's timeout already decided the stash failed; awaiting
  // the drop queued behind that write kept it parked another 10 s.
  it("a stash parked on a locked wallet gives up at chunk 0's bound and drops every chunk", async () => {
    await persistSnapshotSecretsForTests(keys(40, "old"));
    const before = keyring.store!.size;
    expect(before).toBeGreaterThan(2);
    vi.useFakeTimers();
    try {
      let unlock!: () => void;
      const wallet = new Promise<void>((r) => (unlock = r));
      const accounts = Array.from({ length: before }, (_, i) =>
        i === 0 ? "__sync_snapshot_secrets__" : `__sync_snapshot_secrets_${i}__`,
      );
      for (const account of accounts) keyring.parkWrites.set(account, wallet);
      let settled = false;
      const pending = persistSnapshotSecretsForTests(keys(40, "new")).then((r) => ((settled = true), r));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(settled).toBe(true);
      const { ids, chunks } = await pending;
      expect(chunks).toBe(before);
      expect(keyring.deletes).toEqual([]); // queued behind the parked writes
      // The prompt answered late: the parked writes land, then every queued delete behind them.
      unlock();
      await vi.advanceTimersByTimeAsync(0);
      expect([...keyring.deletes].sort()).toEqual([...accounts].sort());
      expect(keyring.store!.size).toBe(0);
      expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: true, restored: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a later chunk's fast failure settles the stash without waiting on a parked chunk 0", async () => {
    vi.useFakeTimers();
    try {
      let unlock!: () => void;
      keyring.parkWrites.set("__sync_snapshot_secrets__", new Promise<void>((r) => (unlock = r)));
      keyring.failWrites.add("__sync_snapshot_secrets_1__");
      let settled = false;
      const pending = persistSnapshotSecretsForTests(keys(20, "sk")).then((r) => ((settled = true), r));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      const { ids, chunks } = await pending;
      expect(chunks).toBeGreaterThan(1);
      expect(keyring.deletes).toEqual([]); // queued behind the parked chunk 0
      unlock();
      await vi.advanceTimersByTimeAsync(0);
      expect(keyring.deletes).toHaveLength(chunks!);
      expect(keyring.store!.size).toBe(0);
      expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: true, restored: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never cuts a surrogate pair between two accounts", async () => {
    // `{"a":"` is 6 units, so the pair sits at units 999-1000: straddling a naive 1000-unit cut.
    const secrets = { a: `${"x".repeat(993)}\u{1F511}${"y".repeat(10)}` };
    const { ids, chunks } = await persistSnapshotSecretsForTests(secrets);
    expect(chunks).toBe(2);
    expect(await restoreSnapshotSecretsForTests(ids, chunks)).toEqual({ blocked: false, restored: secrets });
  });
});

// Every editor trims the server profile name on save and the UI shows it trimmed; a peer's
// untrimmed copy was sent verbatim and missed the server profile.
describe("sanitizers trim overrideProfile", () => {
  it("Backend: trimmed, blank → unset", () => {
    const [padded, blank] = sanitizeBackends([
      backend({ id: "b1", overrideProfile: "  x " }),
      backend({ id: "b2", overrideProfile: "   " }),
    ]);
    expect(padded.overrideProfile).toBe("x");
    expect(blank.overrideProfile).toBeUndefined();
  });

  it("Profile: trimmed, blank → unset", () => {
    const [padded, blank] = sanitizeProfiles([
      profile({ id: "p1", overrideProfile: " clinic-de " }),
      profile({ id: "p2", overrideProfile: "" }),
    ]);
    expect(padded.overrideProfile).toBe("clinic-de");
    expect(blank.overrideProfile).toBeUndefined();
  });
});

// initSync holds the engine lock across the launch work (the keyring restore parks up to 10 s on a
// locked wallet), and a manual Push / Pull clicked then used to drop at the gate without a word —
// the startup pull that followed is an automatic one, so the forced push never happened. A fresh
// engine per case (initSync runs once per module), "in Tauri", with the launch keyring read parked.
describe("a manual Push / Pull clicked during launch", () => {
  const io = {
    release: (_v: Record<string, string>) => {},
    launchRead: false,
    released: false,
    pushes: [] as { blob: SyncBlob; afterRelease: boolean }[],
    pull: null as unknown,
    // When set, answers syncPull instead of `pull` (a hung startup pull).
    pullFn: null as null | (() => Promise<unknown>),
    pulls: 0,
    // When set, keyring deletes wait on it (a reset's delete queued behind launch's read).
    delHold: null as Promise<void> | null,
  };

  async function launchEngine() {
    io.launchRead = false;
    io.released = false;
    io.pushes = [];
    io.pullFn = null;
    io.pulls = 0;
    io.delHold = null;
    const parked = new Promise<Record<string, string>>((r) => {
      io.release = (v) => {
        io.released = true;
        r(v);
      };
    });
    vi.resetModules();
    vi.doMock("../persistence", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../persistence")>()),
      configReady: Promise.resolve(),
    }));
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      isTauri: true,
      // Version 1, synced from this server, with a stashed snapshot key to restore at launch.
      loadSyncState: async () => ({ version: 1, updatedAt: 1, device: "peer", serverBackendId: "b1", snapshot: {}, snapshotSecretIds: ["b1"] }),
      saveSyncState: async () => {},
      syncDeviceInfo: async () => ({ deviceId: "d1", hostname: "me", platform: "linux" }),
      readBackendKeys: (ids: string[]) => {
        if (ids.includes("__sync_snapshot_secrets__")) {
          io.launchRead = true;
          return parked;
        }
        return Promise.resolve({ b1: "sk-1" });
      },
      setBackendKey: async () => {},
      deleteBackendKey: () => io.delHold ?? Promise.resolve(),
      syncPull: async () => {
        io.pulls++;
        return io.pullFn ? io.pullFn() : io.pull;
      },
      syncPush: async (args: { blob: SyncBlob; baseVersion: number }) => {
        io.pushes.push({ blob: args.blob, afterRelease: io.released });
        return { ok: true, status: 200, state: { version: args.baseVersion + 1, updated_ts: 2, device: "me", blob: {} } };
      },
    }));
    const engine = await import("./sync");
    const store = (await import("../store")).useApp;
    const s = settings();
    s.sync = { ...s.sync!, enabled: true, backendId: "b1" };
    store.setState({ settings: s, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
    vi.stubGlobal("window", { addEventListener: () => {} }); // the focus-pull listener
    const init = engine.initSync();
    await vi.waitFor(() => expect(io.launchRead).toBe(true));
    return { engine, store, init };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../api");
    vi.doUnmock("../persistence");
    vi.resetModules();
  });

  it("runs once launch and the startup pull are done, even with nothing changed since the last sync", async () => {
    // The server still holds this device's version: the startup pull has nothing new to apply.
    io.pull = { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} } };
    const { engine, store, init } = await launchEngine();
    try {
      await engine.pushNow(); // an automatic push still drops at the gate during launch
      const click = engine.pushNow(true);
      await Promise.resolve();
      expect(io.pushes).toEqual([]);
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await click;
      expect(io.pushes.length).toBe(1); // forced: the hash check would have skipped an automatic one
      expect(io.pushes[0].afterRelease).toBe(true);
      expect(io.pushes[0].blob.backends?.secrets).toEqual({ b1: "sk-1" });
    } finally {
      io.release({});
      // Sync off: cancels the startup pull's scheduled push.
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a sync-server switch does not wait for a startup pull that hangs", async () => {
    // The configured server is unreachable: the startup pull waits out its timeout. The user
    // switches to another server meanwhile — its pull must start at once, as before launch waited.
    io.pull = { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} } };
    const { store, init } = await launchEngine();
    let hung = true;
    io.pullFn = () => (hung ? new Promise(() => {}) : Promise.resolve(io.pull));
    try {
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(io.pulls).toBe(1)); // the startup pull, now hung
      hung = false;
      store.setState((st) => ({
        backends: [...st.backends, backend({ id: "b2", hasApiKey: true })],
        settings: { ...st.settings, sync: { ...st.settings.sync!, backendId: "b2" } },
      }));
      await vi.waitFor(() => expect(io.pulls).toBe(2));
    } finally {
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a server-copy delete made while it waits voids the click", async () => {
    io.pull = { ok: false, status: 0, error: "unreachable" };
    const { engine, store, init } = await launchEngine();
    try {
      const click = engine.pushNow(true);
      await engine.resetSyncState(); // supersedes the launch epoch
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await click;
      expect(io.pushes).toEqual([]);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a click made after a server-copy delete still waits for the keys launch is restoring", async () => {
    io.pull = { ok: false, status: 0, error: "unreachable" };
    const { engine, store, init } = await launchEngine();
    try {
      await engine.resetSyncState(); // mid launch work: the snapshot keys are still being read
      const click = engine.pushNow(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(io.pushes).toEqual([]);
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await click;
      expect(io.pushes.length).toBeGreaterThan(0); // the click ran
      expect(io.pushes.every((p) => p.afterRelease)).toBe(true);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("repeated Push clicks during launch run as one push", async () => {
    io.pull = { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} } };
    const { engine, store, init } = await launchEngine();
    try {
      const clicks = [engine.pushNow(true), engine.pushNow(true), engine.pushNow(true)];
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await Promise.all(clicks);
      expect(io.pushes.length).toBe(1);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a Push clicked after a server-copy delete is not folded into one the delete voided", async () => {
    io.pull = { ok: false, status: 0, error: "unreachable" };
    const { engine, store, init } = await launchEngine();
    try {
      const before = engine.pushNow(true); // voided by the delete below
      await engine.resetSyncState();
      const after = engine.pushNow(true);
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await Promise.all([before, after]);
      expect(io.pushes.length).toBe(1);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a Pull and a Push both clicked during launch both run", async () => {
    io.pull = { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} } };
    const { engine, store, init } = await launchEngine();
    try {
      const pull = engine.pullNow(true);
      const push = engine.pushNow(true);
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await Promise.all([pull, push]);
      expect(io.pulls).toBe(2); // the startup pull and the click
      expect(io.pushes.length).toBeGreaterThan(0); // the Push click (a forced pull may add one)
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a click made after a server-copy delete runs even when the delete outlasts launch", async () => {
    io.pull = { ok: false, status: 0, error: "unreachable" };
    const { engine, store, init } = await launchEngine();
    let endDelete!: () => void;
    io.delHold = new Promise<void>((r) => (endDelete = r));
    try {
      const reset = engine.resetSyncState(); // holds the lock until its keyring delete lands
      const click = engine.pushNow(true);
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init; // launch ends; the startup pull dropped at the reset's lock
      await new Promise((r) => setTimeout(r, 50));
      expect(io.pushes).toEqual([]);
      endDelete();
      await reset;
      await click;
      expect(io.pushes.length).toBe(1);
    } finally {
      endDelete();
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });
});

// The store subscriber is armed only after the launch work, so a sync edit made during it never
// reached the arms that force a pull. The startup pull then found the server version unchanged,
// skipped the reconcile and queued a push of this device's value. The base here holds no
// `logging` category while the server's carries one, so a reconcile raises the conflict instead.
describe("a sync edit made during the launch work", () => {
  const io = {
    release: (_v: Record<string, string>) => {},
    launchRead: false,
    pushes: 0,
    pulls: 0,
  };
  const REMOTE = {
    ok: true,
    status: 200,
    // The version this device last synced: nothing new by version.
    state: { version: 1, updated_ts: 1, device: "peer", blob: { logging: { logLevel: "debug", keepDays: 30, showInSidebar: true } } },
  };

  async function launchEngine(syncAtLaunch: Partial<NonNullable<AppSettings["sync"]>>, snapshot: SyncBlob = {}) {
    io.launchRead = false;
    io.pushes = 0;
    io.pulls = 0;
    const parked = new Promise<Record<string, string>>((r) => (io.release = r));
    vi.resetModules();
    vi.doMock("../persistence", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../persistence")>()),
      configReady: Promise.resolve(),
    }));
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      isTauri: true,
      loadSyncState: async () => ({ version: 1, updatedAt: 1, device: "peer", serverBackendId: "b1", snapshot, snapshotSecretIds: ["b1"] }),
      saveSyncState: async () => {},
      syncDeviceInfo: async () => ({ deviceId: "d1", hostname: "me", platform: "linux" }),
      readBackendKeys: (ids: string[]) => {
        if (ids.includes("__sync_snapshot_secrets__")) {
          io.launchRead = true;
          return parked;
        }
        return Promise.resolve({ b1: "sk-1" });
      },
      setBackendKey: async () => {},
      deleteBackendKey: async () => {},
      syncPull: async () => {
        io.pulls++;
        return REMOTE;
      },
      syncPush: async (args: { baseVersion: number }) => {
        io.pushes++;
        return { ok: true, status: 200, state: { version: args.baseVersion + 1, updated_ts: 2, device: "me", blob: {} } };
      },
    }));
    const engine = await import("./sync");
    const store = (await import("../store")).useApp;
    const s = settings();
    s.sync = { ...s.sync!, enabled: true, backendId: "b1", ...syncAtLaunch };
    store.setState({ settings: s, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
    vi.stubGlobal("window", { addEventListener: () => {} });
    const init = engine.initSync();
    await vi.waitFor(() => expect(io.launchRead).toBe(true));
    return { engine, store, init };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../api");
    vi.doUnmock("../persistence");
    vi.resetModules();
  });

  it("a gate turned ON reconciles against the server instead of pushing over it", async () => {
    // Every `logging` gate off at launch: the category is off until "Log level" comes on.
    const sub = { ...DEFAULT_SETTINGS.sync!.sub, logLevel: false, logRetention: false, logsInSidebar: false, logFolder: false } as SyncSubSettings;
    const { engine, store, init } = await launchEngine({ sub });
    try {
      store.setState((st) => ({
        settings: { ...st.settings, sync: { ...st.settings.sync!, sub: { ...sub, logLevel: true } } },
      }));
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).not.toBe("syncing"));
      expect(io.pulls).toBe(1);
      expect(engine.getPendingConflict()?.categories).toEqual(["logging"]);
      expect(io.pushes).toBe(0);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  // The real shape of a re-enabled category: while its gates were off, every adopted base
  // passed the server's copy through, so the base EQUALS the server for it. Merged against that
  // base, this device's different value read as "changed here only" and was pushed over the peer's.
  const offSub = { ...DEFAULT_SETTINGS.sync!.sub, logLevel: false, logRetention: false, logsInSidebar: false, logFolder: false } as SyncSubSettings;
  const serverCopy = REMOTE.state.blob as SyncBlob;

  it("a category turned ON with a value different from the server's asks instead of pushing over it", async () => {
    const { engine, store, init } = await launchEngine({ sub: offSub }, serverCopy);
    try {
      store.setState((st) => ({
        settings: {
          ...st.settings,
          logging: { ...st.settings.logging!, logLevel: "warn" },
          sync: { ...st.settings.sync!, sub: { ...offSub, logLevel: true } },
        },
      }));
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).not.toBe("syncing"));
      await new Promise((r) => setTimeout(r, 30)); // a push the reconcile queued would land now
      expect(engine.getPendingConflict()?.categories).toEqual(["logging"]);
      expect(io.pushes).toBe(0);
      expect(store.getState().settings.logging?.logLevel).toBe("warn"); // nothing decided for the user
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a category turned ON with the server's own value merges without asking", async () => {
    const { engine, store, init } = await launchEngine({ sub: offSub }, serverCopy);
    try {
      store.setState((st) => ({
        settings: {
          ...st.settings,
          logging: { ...st.settings.logging!, logLevel: "debug" },
          sync: { ...st.settings.sync!, sub: { ...offSub, logLevel: true } },
        },
      }));
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).toBe("ok"));
      expect(engine.getPendingConflict()).toBeNull();
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("a category turned ON after launch asks too, and nothing is pushed while the dialog waits", async () => {
    const { engine, store, init } = await launchEngine({ sub: offSub }, serverCopy);
    try {
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).not.toBe("syncing"));
      const pullsBefore = io.pulls;
      store.setState((st) => ({ settings: { ...st.settings, logging: { ...st.settings.logging!, logLevel: "warn" } } }));
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, sub: { ...offSub, logLevel: true } } } }));
      await vi.waitFor(() => expect(engine.getPendingConflict()?.categories).toEqual(["logging"]));
      expect(io.pulls).toBe(pullsBefore + 1);
      await engine.pushNow(true); // the dialog waits: no push goes up meanwhile
      expect(io.pushes).toBe(0);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("sync turned on reconciles against the server instead of pushing over it", async () => {
    const { engine, store, init } = await launchEngine({ enabled: false });
    try {
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: true } } }));
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).not.toBe("syncing"));
      expect(io.pulls).toBe(1);
      expect(engine.getPendingConflict()?.categories).toEqual(["logging"]);
      expect(io.pushes).toBe(0);
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });

  it("with the sync settings unchanged the startup pull stays automatic", async () => {
    // Same gate set as above, ON from launch: an unchanged version is "nothing new", as before.
    const { engine, store, init } = await launchEngine({});
    try {
      io.release({ __sync_snapshot_secrets__: JSON.stringify({ b1: "sk-1" }) });
      await init;
      await vi.waitFor(() => expect(store.getState().syncStatus).toBe("ok"));
      expect(io.pulls).toBe(1);
      expect(engine.getPendingConflict()).toBeNull();
      expect(io.pushes).toBe(0); // the automatic push is still 3 s out
    } finally {
      io.release({});
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    }
  });
});

// pushNow's "ship only what config.json holds" gate read the save banner, which the user can
// dismiss: closing "Couldn't save your settings" and pressing Push now then sent the unsaved store.
// Real persistence under a fresh engine; `io.saveFails` is the disk.
describe("a push after a failed config save", () => {
  const io = {
    saveFails: true,
    saves: 0,
    pushes: [] as SyncBlob[],
    states: [] as number[],
    pull: { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} as SyncBlob } },
  };

  async function armEngine() {
    io.saveFails = true;
    io.saves = 0;
    io.pushes = [];
    io.states = [];
    io.pull = { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "peer", blob: {} } };
    vi.resetModules();
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      isTauri: true,
      loadConfig: async () => null,
      saveConfig: async () => {
        io.saves++;
        if (io.saveFails) throw new Error("read-only file system");
      },
      evdevStatus: async () => ({ permitted: false }),
      loadSyncState: async () => ({ version: 1, updatedAt: 1, device: "peer", serverBackendId: "b1", snapshot: {} }),
      saveSyncState: async (st: { version?: number }) => {
        io.states.push(st.version ?? 0);
      },
      syncDeviceInfo: async () => ({ deviceId: "d1", hostname: "me", platform: "linux" }),
      readBackendKeys: async () => ({ b1: "sk-1" }),
      setBackendKey: async () => {},
      deleteBackendKey: async () => {},
      syncPull: async () => io.pull,
      syncPush: async (args: { blob: SyncBlob; baseVersion: number }) => {
        io.pushes.push(args.blob);
        return { ok: true, status: 200, state: { version: args.baseVersion + 1, updated_ts: 2, device: "me", blob: {} } };
      },
    }));
    const persistence = await import("../persistence");
    const engine = await import("./sync");
    const store = (await import("../store")).useApp;
    const s = settings();
    s.sync = { ...s.sync!, enabled: true, backendId: "b1" };
    store.setState({ settings: s, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
    vi.stubGlobal("window", { addEventListener: () => {} });
    await persistence.initConfig();
    await engine.initSync();
    await vi.waitFor(() => expect(store.getState().syncStatus).toBe("ok"));
    /** A store edit whose save fails, its banner dismissed: config.json is behind the store. */
    const failedEdit = async () => {
      store.setState((st) => ({ settings: { ...st.settings, logging: { ...st.settings.logging!, logLevel: "debug" } } }));
      await vi.waitFor(() => expect(store.getState().saveErrorKind).toBe("save"));
      store.getState().setSaveError(null); // the banner's dismiss button
      expect(persistence.configSaveHeld()).toBe(true);
    };
    const syncOff = () =>
      store.setState((st) => ({ settings: { ...st.settings, sync: { ...st.settings.sync!, enabled: false } } }));
    return { persistence, engine, store, failedEdit, syncOff };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../api");
    vi.resetModules();
  });

  it("sends nothing even once the save banner is dismissed", async () => {
    const { persistence, engine, store, failedEdit, syncOff } = await armEngine();
    try {
      await failedEdit();
      await engine.pushNow(true);
      expect(io.pushes.length).toBe(0);
      // A save that lands lifts the hold.
      io.saveFails = false;
      store.setState((st) => ({ settings: { ...st.settings, logging: { ...st.settings.logging!, keepDays: 7 } } }));
      await persistence.flushConfigSave();
      await engine.pushNow(true);
      expect(io.pushes.length).toBe(1);
    } finally {
      syncOff();
    }
  });

  it("the quit flush retries a held save once the disk recovered, with no edit since", async () => {
    const { persistence, failedEdit, syncOff } = await armEngine();
    try {
      await failedEdit();
      io.saveFails = false;
      const before = io.saves;
      await persistence.flushConfigSave();
      expect(io.saves).toBe(before + 1);
      expect(persistence.configSaveHeld()).toBe(false);
    } finally {
      syncOff();
    }
  });

  it("Push now retries the held save and pushes once it lands", async () => {
    const { persistence, engine, failedEdit, syncOff } = await armEngine();
    try {
      await failedEdit();
      io.saveFails = false; // recovered — and no store edit re-issues the save
      await engine.pushNow(true);
      expect(persistence.configSaveHeld()).toBe(false);
      expect(io.pushes.length).toBe(1);
    } finally {
      syncOff();
    }
  });

  it("Push now says why nothing was pushed while the save still fails; an automatic push stays quiet", async () => {
    const { engine, store, failedEdit, syncOff } = await armEngine();
    try {
      await failedEdit();
      await engine.pushNow();
      expect(store.getState().syncStatus).toBe("ok");
      expect(store.getState().syncError).toBeNull();
      await engine.pushNow(true);
      expect(io.pushes.length).toBe(0);
      expect(store.getState().syncStatus).toBe("error");
      expect(store.getState().syncError).toMatch(/couldn't save its settings, so nothing was pushed/);
      expect(store.getState().saveErrorKind).toBe("save"); // the retry failed again: its banner is back
    } finally {
      syncOff();
    }
  });

  it("a push the hold refused goes out once a save lifts the hold, with no store edit", async () => {
    const { persistence, engine, failedEdit, syncOff } = await armEngine();
    try {
      await failedEdit();
      await engine.pushNow(); // the debounced push, refused at the gate
      expect(io.pushes.length).toBe(0);
      io.saveFails = false;
      await persistence.flushConfigSave(); // a save the engine's store subscriber never saw
      await vi.waitFor(() => expect(io.pushes.length).toBe(1));
    } finally {
      syncOff();
    }
  });

  it("the held-save line goes once the save lands, even when the owed push has nothing to send", async () => {
    const { persistence, engine, store, failedEdit, syncOff } = await armEngine();
    try {
      io.saveFails = false;
      await engine.pushNow(true); // the base: this device's compose as it is now
      expect(io.pushes.length).toBe(1);
      const level = store.getState().settings.logging?.logLevel;
      io.saveFails = true;
      await failedEdit();
      await engine.pushNow(true);
      expect(store.getState().syncError).toMatch(/couldn't save its settings, so nothing was pushed/);
      // The edit is undone and that save lands: the owed push finds nothing new to send.
      io.saveFails = false;
      store.setState((st) => ({ settings: { ...st.settings, logging: { ...st.settings.logging!, logLevel: level! } } }));
      await persistence.flushConfigSave();
      await vi.waitFor(() => expect(store.getState().syncError).toBeNull());
      await vi.waitFor(() => expect(store.getState().syncStatus).not.toBe("syncing"));
      expect(store.getState().syncStatus).not.toBe("error");
      expect(io.pushes.length).toBe(1);
    } finally {
      syncOff();
    }
  });
});
