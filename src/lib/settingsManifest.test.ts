import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTING_SYNC,
  GENERAL_COVERAGE,
  LOCAL,
  LOGGING_COVERAGE,
  MANIFEST,
  RECORDING_COVERAGE,
  SETTING,
  SYNC_GROUPS,
  TOP_COVERAGE,
  TRANSCRIBE_COVERAGE,
  settingsOfGroup,
  type FieldRef,
  type SettingDef,
} from "./settingsManifest";

const DEFS: readonly SettingDef[] = MANIFEST;

describe("manifest integrity", () => {
  it("ids are unique", () => {
    const ids = DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parents exist and share their child's group", () => {
    for (const d of DEFS) {
      if (!d.parent) continue;
      const parent = SETTING[d.parent as keyof typeof SETTING];
      expect(parent, `${d.id} parent ${d.parent}`).toBeTruthy();
      expect(parent.group).toBe(d.group);
    }
  });

  it("every group has at least one setting; every setting a known group", () => {
    for (const g of SYNC_GROUPS) expect(settingsOfGroup(g).length).toBeGreaterThan(0);
    for (const d of DEFS) expect(SYNC_GROUPS).toContain(d.group);
  });

  it("machineSpecific settings default to sync OFF, others ON", () => {
    for (const d of DEFS) {
      expect(DEFAULT_SETTING_SYNC[d.id as keyof typeof DEFAULT_SETTING_SYNC]).toBe(
        !d.machineSpecific && !d.localOnly,
      );
    }
  });

  it("custom (list-arm) entries carry no scalar fields — except explicit pointer settings", () => {
    // homeProfile/pinnedMappings gate a custom arm AND own their pointer field.
    const pointerCustoms = new Set(["homeProfile", "pinnedMappings"]);
    for (const d of DEFS) {
      if (d.custom && !pointerCustoms.has(d.id)) {
        expect(d.fields.length, d.id).toBe(0);
      }
      if (!d.custom && !d.localOnly) expect(d.fields.length, `${d.id} must own fields`).toBeGreaterThan(0);
    }
  });

  it("coverage maps and manifest fields agree in both directions", () => {
    // Every non-LOCAL coverage value's manifest entry actually owns the field…
    const covs: Array<[FieldRef["slice"], Record<string, unknown>]> = [
      ["general", GENERAL_COVERAGE],
      ["recording", RECORDING_COVERAGE],
      ["transcribe", TRANSCRIBE_COVERAGE],
      ["logging", LOGGING_COVERAGE],
      ["settings", TOP_COVERAGE],
    ];
    const fieldKey = (ref: FieldRef) => `${ref.slice}.${ref.key}`;
    const owned = new Set(DEFS.flatMap((d) => d.fields.map(fieldKey)));
    for (const [slice, cov] of covs) {
      for (const [key, settingId] of Object.entries(cov)) {
        if (settingId === LOCAL) {
          expect(owned.has(`${slice}.${key}`), `${slice}.${key} declared LOCAL but owned`).toBe(false);
          continue;
        }
        const def = SETTING[settingId as keyof typeof SETTING];
        expect(def, `${slice}.${key} → ${String(settingId)}`).toBeTruthy();
        expect(
          def.fields.some((r) => r.slice === slice && r.key === key),
          `${String(settingId)} must own ${slice}.${key}`,
        ).toBe(true);
      }
    }
    // …and every owned field appears in its coverage map (non-LOCAL).
    const covered = new Set(
      covs.flatMap(([slice, cov]) =>
        Object.entries(cov)
          .filter(([, v]) => v !== LOCAL)
          .map(([k]) => `${slice}.${k}`),
      ),
    );
    for (const key of owned) {
      expect(covered.has(key), `${key} owned but not in a coverage map`).toBe(true);
    }
  });

  it("the retired insertTiming has no sync row", () => {
    // The field is kept in the type for rollbacks but has no UI control anywhere, so a
    // per-setting sync switch for it would advertise something the user cannot change.
    expect(DEFS.some((d) => d.fields.some((f) => f.slice === "general" && f.key === "insertTiming"))).toBe(false);
  });

  it("legacy sub-toggle semantics carry over (defaults preserve today's behavior)", () => {
    // The four pre-manifest sub-toggles keep their defaults under new ids.
    expect(DEFAULT_SETTING_SYNC.audioFolder).toBe(false); // was recordingsDir: false
    expect(DEFAULT_SETTING_SYNC.profileHotkeys).toBe(true);
    expect(DEFAULT_SETTING_SYNC.quickAddHotkey).toBe(true);
    expect(DEFAULT_SETTING_SYNC.transcribePicks).toBe(false);
  });
});

describe("completeGates migration", () => {
  it("defaults with nothing saved", async () => {
    const { completeGates } = await import("./settingsManifest");
    const g = completeGates(undefined, undefined);
    expect(g.soundCues).toBe(true);
    expect(g.pasteShortcut).toBe(false); // machine-specific
    expect(g.audioFolder).toBe(false);
  });

  it("an OFF legacy category seeds every member OFF (nothing silently starts syncing)", async () => {
    const { completeGates } = await import("./settingsManifest");
    const g = completeGates(undefined, { chip: false });
    expect(g.autoHideToEdge).toBe(false);
    expect(g.liveTranscript).toBe(false);
    expect(g.soundCues).toBe(true); // other categories untouched
  });

  it("legacy sub keys map onto their new ids; explicit saved gates win over category folding", async () => {
    const { completeGates } = await import("./settingsManifest");
    const g = completeGates(
      { recordingsDir: true, transcribePicks: true, autoHideToEdge: true },
      { chip: false },
    );
    expect(g.audioFolder).toBe(true); // legacy recordingsDir → audioFolder
    expect(g.transcribePicks).toBe(true);
    expect(g.autoHideToEdge).toBe(true); // saved gate beats the OFF category fold
    expect(g.liveTranscript).toBe(false); // unfolded member stays category-off
  });
});

describe("store completion of a pre-split config", () => {
  it("an OFF pre-split category keeps its split-out members OFF after migration", async () => {
    const { withSettingsDefaults } = await import("./store");
    const settings = withSettingsDefaults({ sync: { categories: { recording: false, general: false } } });
    const sub = settings.sync!.sub!;
    // chip was split out of recording, dictionary out of general
    expect(sub.chipPosition).toBe(false);
    expect(sub.liveTranscript).toBe(false);
    expect(sub.quickAddHotkey).toBe(false);
    expect(sub.pinnedMappings).toBe(false);
    expect(sub.backendList).toBe(true); // unrelated category untouched
  });

  it("legacy latchAutoStop survives a completion round-trip (downgrade keeps the intent)", async () => {
    const { withSettingsDefaults } = await import("./store");
    const sub = withSettingsDefaults({ sync: { sub: { latchAutoStop: false } } }).sync!.sub!;
    expect(sub.handsFreeAutoStop).toBe(false);
    expect(sub.latchAutoStop).toBe(false);
  });

  it("DEFAULT_SYNC.sub agrees with the manifest so the two can never drift", async () => {
    const { DEFAULT_SYNC } = await import("./defaults");
    const sub = DEFAULT_SYNC.sub!;
    expect(sub.profileHotkeys).toBe(DEFAULT_SETTING_SYNC.profileHotkeys);
    expect(sub.quickAddHotkey).toBe(DEFAULT_SETTING_SYNC.quickAddHotkey);
    expect(sub.transcribePicks).toBe(DEFAULT_SETTING_SYNC.transcribePicks);
    expect(sub.recordingsDir).toBe(DEFAULT_SETTING_SYNC.audioFolder);
    const vals = Object.values(DEFAULT_SETTING_SYNC);
    expect(vals.some((v) => !v)).toBe(true); // a boolean "sync everything" master can never read on by default
    expect(vals.some((v) => v)).toBe(true);
  });
});
