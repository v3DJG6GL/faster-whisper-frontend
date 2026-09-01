// Retiring the global three-way `insertTiming` onto the per-Profile `typeAsISpeak`.
//
// The mapping is consent-grade in one direction: `"off"` meant *never insert anywhere*,
// so getting it wrong starts typing into the focused app for someone who had deliberately
// turned insertion off. These pin all three values, and the seeding rule that goes with
// them — a "stop" user must not come back as a live-typing one.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, migrateInsertTiming, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import type { AppSettings, InsertTiming, Profile } from "./types";

const settingsWith = (timing: InsertTiming, insertMethod: AppSettings["general"]["insertMethod"] = "paste"): AppSettings => ({
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, insertTiming: timing, insertMethod },
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "p1",
  name: "Mail",
  activation: "handsfree",
  enabled: true,
  hotkey: ["ControlLeft", "KeyM"],
  backendId: null,
  ...over,
});

describe("migrateInsertTiming", () => {
  it('maps "live" onto typeAsISpeak for every existing profile', () => {
    const r = migrateInsertTiming(settingsWith("live"), [profile(), profile({ id: "p2" })]);
    expect(r.profiles.map((p) => p.typeAsISpeak)).toEqual([true, true]);
  });

  it("seeds the GLOBAL default too, so a profile's Inherit resolves to the old behaviour", () => {
    // Without this the editor offers "Inherit" with nothing to inherit from, and it
    // silently means "off" — the defect that shipped in the first cut.
    expect(migrateInsertTiming(settingsWith("live"), []).settings.general.typeAsISpeak).toBe(true);
    expect(migrateInsertTiming(settingsWith("stop"), []).settings.general.typeAsISpeak).toBe(false);
    expect(migrateInsertTiming(settingsWith("off"), []).settings.general.typeAsISpeak).toBe(false);
  });

  it('maps "stop" onto typeAsISpeak=false — NOT the new-profile default', () => {
    // Defaulting instead of seeding would hand a "stop" user live typing.
    const r = migrateInsertTiming(settingsWith("stop"), [profile()]);
    expect(r.profiles[0].typeAsISpeak).toBe(false);
  });

  it('maps "off" onto an insert method that types nothing', () => {
    // The dangerous one. "off" meant transcribe-but-never-insert; the boolean cannot
    // express that, so it moves to the method — text still reaches the clipboard.
    const r = migrateInsertTiming(settingsWith("off"), [profile()]);
    expect(r.settings.general.insertMethod).toBe("clipboard");
    expect(r.profiles[0].typeAsISpeak).toBe(false);
  });

  it('does not touch the insert method for "stop" or "live"', () => {
    expect(migrateInsertTiming(settingsWith("stop", "direct"), []).settings.general.insertMethod).toBe("direct");
    expect(migrateInsertTiming(settingsWith("live", "direct"), []).settings.general.insertMethod).toBe("direct");
  });

  it('writes back the conservative "stop" for a downgraded build to read', () => {
    // An older build still honours the field, and its own default is "live" — so leaving
    // it as-is (or deleting it) would turn live typing ON for an "off"/"stop" user on rollback.
    for (const t of ["off", "stop", "live"] as const) {
      expect(migrateInsertTiming(settingsWith(t), []).settings.general.insertTiming).toBe("stop");
    }
  });

  it("leaves a profile that already has an explicit value alone", () => {
    // A config written by a newer build and re-read through this path must not be re-seeded.
    const r = migrateInsertTiming(settingsWith("live"), [profile({ typeAsISpeak: false })]);
    expect(r.profiles[0].typeAsISpeak).toBe(false);
  });

  it("runs once per config: a second launch on the config it wrote keeps typeAsISpeak", () => {
    // `insertTiming` is never absent (Rust always writes it back), so the gate lives in
    // `migrateConfig` on the schema version, not on the field. Load a v2 config, flip the
    // new toggle on, save-shape it as the app would, load again: the migration must not
    // re-run and reset the toggle to the conservative write-back value.
    const store = useApp.getState();
    store.hydrate({ settings: settingsWith("stop"), backends: [], profiles: [profile()], version: 2 });
    expect(useApp.getState().settings.general.typeAsISpeak).toBe(false);

    const s1 = useApp.getState();
    const saved = {
      settings: { ...s1.settings, general: { ...s1.settings.general, typeAsISpeak: true } },
      backends: s1.backends,
      profiles: s1.profiles.map((p) => ({ ...p, typeAsISpeak: undefined })),
      version: CONFIG_VERSION,
    };
    useApp.getState().hydrate(saved);
    expect(useApp.getState().settings.general.typeAsISpeak).toBe(true);
    expect(useApp.getState().profiles[0].typeAsISpeak).toBeUndefined();
  });

  it("still migrates a config that predates the version stamp", () => {
    useApp.getState().hydrate({ settings: settingsWith("live"), backends: [], profiles: [profile()] });
    expect(useApp.getState().settings.general.typeAsISpeak).toBe(true);
    expect(useApp.getState().profiles[0].typeAsISpeak).toBe(true);
  });
});
