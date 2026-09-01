// Baseline fixtures locking the sync engine's compose/apply/merge behavior
// BEFORE (and after) the per-setting gate refactor — the wire-neutrality
// proof. Outside Tauri every api call no-ops, so composeBlob/applyBlob run
// as pure-ish functions over the store.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_CATEGORIES,
  applyBlob,
  composeBlob,
  mergeBlobs,
  migrateBlob,
  securityChanges,
} from "./sync";
import { useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { IS_WINDOWS } from "./platform";
import type { SyncBlob } from "./syncTypes";
import type { AppSettings, Backend, Profile, SyncCategory, SyncSubSettings } from "./types";

/** Test seam for the ONE await inside applyBlob (the keyring reconciliation): while it is
 *  parked, the store is live and the user can keep editing. Default is passthrough. */
const keyring = vi.hoisted(() => ({ park: null as null | Promise<Record<string, string>> }));
vi.mock("./api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./api")>();
  return {
    ...orig,
    readBackendKeys: (ids: string[]) => keyring.park ?? orig.readBackendKeys(ids),
  };
});

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

  it("defers (returns false, applies nothing) while dictation is live", async () => {
    useApp.setState({ status: "recording" as never });
    const before = useApp.getState().settings;
    const applied = await applyBlob(
      { chip: { indicatorPosition: "bottom" } as never },
      CATS_ALL,
    );
    expect(applied).toBe(false);
    expect(useApp.getState().settings).toBe(before); // untouched — stashed for later
    useApp.setState({ status: "idle" });
    expect(await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL)).toBe(true);
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

  it("an explicit restore applies machine-specific settings the sync switches would gate", async () => {
    // Chip position's switch is OFF on a stock install; a backup must still restore it.
    useApp.setState({ settings: settings() });
    await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL);
    expect(useApp.getState().settings.recording.indicatorPosition).toBe("top"); // sync round: gated
    await applyBlob({ chip: { indicatorPosition: "bottom" } as never }, CATS_ALL, 2, { ignoreGates: true });
    expect(useApp.getState().settings.recording.indicatorPosition).toBe("bottom"); // restore: applied
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
});
