// Two-device fixtures for the per-setting sync gates: compose-side snapshot
// passthrough, apply-side keep-local, the element-wise list arms, and the
// wire-neutrality proof (all gates on ≡ ungated compose).

import { beforeEach, describe, expect, it } from "vitest";
import { ALL_CATEGORIES, applyBlob, composeBlob, mergeBlobs } from "./sync";
import { completeGates, DEFAULT_SETTING_SYNC } from "./settingsManifest";
import { catsFromGates, gateApplyScalar, gateComposeScalar } from "./syncGates";
import { stableStringify } from "./stable";
import { useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import type { SyncBlob } from "./syncTypes";
import type { AppSettings, Backend, Profile, SyncCategory, SyncSubSettings } from "./types";

const CATS_ALL = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, true])) as Record<
  SyncCategory,
  boolean
>;
const SUB_ALL: SyncSubSettings = {
  recordingsDir: true,
  profileHotkeys: true,
  quickAddHotkey: true,
  transcribePicks: true,
};
const GATES_ALL = Object.fromEntries(
  Object.keys(DEFAULT_SETTING_SYNC).map((k) => [k, true]),
) as typeof DEFAULT_SETTING_SYNC;

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
  return { settings: settings(), backends: [backend()], profiles: [profile()], appRules: [], ...over };
}

describe("compose: scalar gate passthrough", () => {
  it("a gated-off general setting ships the snapshot's value, not this device's edit", async () => {
    const cfg = slice();
    cfg.settings.general.soundEffects = false; // local edit, gate off
    const snapshot: SyncBlob = { general: { soundEffects: true } as never };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, soundCues: false },
    });
    expect(blob.general?.soundEffects).toBe(true);
  });

  it("gated-off with no snapshot value: the field is omitted (absent ≠ delete)", async () => {
    const cfg = slice();
    const blob = await composeBlob(cfg, CATS_ALL, {}, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, soundCues: false },
    });
    expect("soundEffects" in (blob.general as object)).toBe(false);
  });

  it("a multi-field setting gates all its fields together (Live transcript)", async () => {
    const cfg = slice();
    cfg.settings.recording.realtimePreview = false;
    cfg.settings.recording.realtimePreviewOnHover = true;
    const snapshot: SyncBlob = {
      chip: { realtimePreview: true, realtimePreviewOnHover: false } as never,
    };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, liveTranscript: false },
    });
    expect((blob.chip as Record<string, unknown>).realtimePreview).toBe(true);
    expect((blob.chip as Record<string, unknown>).realtimePreviewOnHover).toBe(false);
  });

  it("all gates on composes byte-identical to an ungated compose", async () => {
    const cfg = slice();
    cfg.settings.transcribe = { diarize: true, model: "small" };
    const snapshot: SyncBlob = { general: { soundEffects: true } as never };
    const gated = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: GATES_ALL,
    });
    const ungated = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
    });
    // `logging.logDir` is the one deliberate difference: its gate is what
    // ships the path at all (an ungated compose — the export contract —
    // never includes it). Everything else must be byte-identical.
    // Only `logDir` — the other logging fields must stay byte-identical too.
    for (const b of [gated, ungated]) {
      const lg = (b as Record<string, unknown>).logging;
      if (lg && typeof lg === "object") delete (lg as Record<string, unknown>).logDir;
    }
    expect(stableStringify(gated)).toBe(stableStringify(ungated));
  });
});

describe("compose: list arms", () => {
  it("serverAddresses off: known backends ship the snapshot's URL, new ones their live URL", async () => {
    const cfg = slice({
      backends: [backend({ serverUrl: "http://192.168.1.5:8000" }), backend({ id: "b2", serverUrl: "http://new:1" })],
    });
    const snapshot: SyncBlob = { backends: { list: [backend({ serverUrl: "http://peer:9" })] } };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, serverAddresses: false },
    });
    const byId = new Map(blob.backends!.list.map((b) => [b.id, b]));
    expect(byId.get("b1")!.serverUrl).toBe("http://peer:9");
    expect(byId.get("b2")!.serverUrl).toBe("http://new:1");
  });

  it("apiKeys off: the snapshot's secrets travel (or stay absent) — never a keyless overwrite", async () => {
    const snapshot: SyncBlob = { backends: { list: [backend()], secrets: { b1: "sk-peer" } } };
    const blob = await composeBlob(slice(), CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, apiKeys: false },
    });
    expect(blob.backends?.secrets).toEqual({ b1: "sk-peer" });
  });

  it("enabledPerProfile off: enabled states come from the snapshot", async () => {
    const cfg = slice({ profiles: [profile({ enabled: false })] });
    const snapshot: SyncBlob = { profiles: { list: [profile({ enabled: true })], homeProfileId: null } };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, enabledPerProfile: false },
    });
    expect(blob.profiles!.list[0].enabled).toBe(true);
  });

  it("perAppPasteShortcuts off mirrors the snapshot exactly — absence included", async () => {
    const rule = { id: "r1", appId: "konsole", name: "Konsole", block: false, pasteShortcut: ["ControlLeft", "ShiftLeft", "KeyV"] };
    const cfg = { ...slice(), appRules: [rule] as never[] };
    const snapshot: SyncBlob = {
      appRules: { linux: [{ id: "r1", appId: "konsole", name: "Konsole", block: false } as never], windows: [] },
    };
    const blob = await composeBlob(cfg, CATS_ALL, snapshot, {
      includeSecrets: false,
      sub: SUB_ALL,
      gates: { ...GATES_ALL, perAppPasteShortcuts: false },
    });
    const mine = blob.appRules!.linux[0] as unknown as Record<string, unknown>;
    expect("pasteShortcut" in mine).toBe(false); // local chord did not travel
  });
});

describe("apply: keep-local per gate", () => {
  beforeEach(() => {
    useApp.setState({
      settings: settings(),
      backends: [backend()],
      profiles: [profile()],
      appRules: [],
      status: "idle",
    });
  });

  function gateOff(...ids: string[]) {
    const s = settings();
    const sub = { ...completeGates(undefined, undefined) } as Record<string, boolean>;
    for (const id of ids) sub[id] = false;
    for (const id of Object.keys(sub)) if (!ids.includes(id)) sub[id] = true;
    s.sync = { ...s.sync!, sub: sub as never };
    useApp.setState({ settings: s });
  }

  it("a gated-off scalar setting never applies (Sound cues)", async () => {
    gateOff("soundCues");
    await applyBlob(
      { general: { soundEffects: false, startMinimized: true } as never },
      { ...CATS_ALL, backends: false, profiles: false },
    );
    const g = useApp.getState().settings.general;
    expect(g.soundEffects).toBe(true); // kept local
    expect(g.startMinimized).toBe(true); // non-gated applied
  });

  it("serverAddresses off: a known backend keeps this device's URL", async () => {
    gateOff("serverAddresses");
    await applyBlob(
      {
        backends: {
          list: [backend({ serverUrl: "http://evil:1", name: "renamed" }), backend({ id: "b2", serverUrl: "http://new:2", name: "n2" })],
        },
      },
      { ...CATS_ALL, profiles: false },
    );
    const byId = new Map(useApp.getState().backends.map((b) => [b.id, b]));
    expect(byId.get("b1")!.serverUrl).toBe("http://10.0.0.2:8000");
    expect(byId.get("b1")!.name).toBe("renamed");
    expect(byId.get("b2")!.serverUrl).toBe("http://new:2");
  });

  it("homeProfile off: this device's pick survives the blob", async () => {
    gateOff("homeProfile");
    const s = useApp.getState().settings;
    useApp.setState({ settings: { ...s, homeProfileId: "p1" } });
    await applyBlob(
      { profiles: { list: [profile()], homeProfileId: "p9" } },
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().settings.homeProfileId).toBe("p1");
  });
});

describe("catsFromGates", () => {
  it("list categories follow their list switch; scalar categories any member", () => {
    const cats = catsFromGates({ ...GATES_ALL, backendList: false, soundCues: false });
    expect(cats.backends).toBe(false);
    expect(cats.general).toBe(true); // other general members still on
    const none = Object.fromEntries(Object.keys(GATES_ALL).map((k) => [k, false])) as typeof GATES_ALL;
    const catsNone = catsFromGates(none);
    for (const v of Object.values(catsNone)) expect(v).toBe(false);
  });
});

describe("pure helpers", () => {
  it("gateComposeScalar / gateApplyScalar pass non-objects through", () => {
    // A gate must be OFF, or both functions short-circuit on `off.length === 0`
    // and the isPlainObject guard (the string-spread hazard) is never reached.
    const someOff = { ...GATES_ALL, soundCues: false };
    expect(gateComposeScalar("general", "junk", undefined, someOff)).toBe("junk");
    expect(gateApplyScalar("general", "junk", someOff)).toBe("junk");
    expect(gateApplyScalar("general", null, someOff)).toBe(null);
    expect(gateComposeScalar("general", ["a"], undefined, someOff)).toEqual(["a"]);
  });
});

describe("forward-compat: unknown categories carry through", () => {
  it("composeBlob keeps a snapshot category this version doesn't know", async () => {
    const snapshot = { futureCategory: { someFlag: true } } as unknown as SyncBlob;
    const blob = await composeBlob(
      { settings: structuredClone(DEFAULT_SETTINGS), backends: [], profiles: [], appRules: [] },
      CATS_ALL,
      snapshot,
      { includeSecrets: false, sub: SUB_ALL, gates: GATES_ALL },
    );
    expect((blob as Record<string, unknown>).futureCategory).toEqual({ someFlag: true });
  });

  it("mergeBlobs carries an unknown category from either side", () => {
    const remote = { futureCategory: { x: 1 } } as unknown as SyncBlob;
    const fromRemote = mergeBlobs(undefined, {} as SyncBlob, remote).merged;
    expect((fromRemote as Record<string, unknown>).futureCategory).toEqual({ x: 1 });
    const local = { localOnly: { y: 2 } } as unknown as SyncBlob;
    const fromLocal = mergeBlobs(undefined, local, {} as SyncBlob).merged;
    expect((fromLocal as Record<string, unknown>).localOnly).toEqual({ y: 2 });
  });

  it("an own __proto__ key in a remote blob cannot replace the merged blob's prototype", () => {
    // Server JSON: `__proto__` is an ordinary own key after JSON.parse, and a plain `[]=`
    // would invoke the setter — swapping the prototype and DROPPING the key.
    const remote = JSON.parse('{"__proto__":{"general":{"theme":"light"}}}') as SyncBlob;
    const merged = mergeBlobs(undefined, {} as SyncBlob, remote).merged;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.general).toBeUndefined();
  });
});
