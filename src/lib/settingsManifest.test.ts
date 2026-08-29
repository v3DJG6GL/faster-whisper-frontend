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
  isChanged,
  patchFor,
  settingsOfGroup,
  snapshotOf,
  type FieldRef,
  type SettingDef,
} from "./settingsManifest";
import { DEFAULT_SETTINGS } from "./defaults";
import type { AppSettings } from "./types";

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
        !d.machineSpecific,
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
      if (!d.custom) expect(d.fields.length, `${d.id} must own fields`).toBeGreaterThan(0);
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

  it("legacy sub-toggle semantics carry over (defaults preserve today's behavior)", () => {
    // The four pre-manifest sub-toggles keep their defaults under new ids.
    expect(DEFAULT_SETTING_SYNC.audioFolder).toBe(false); // was recordingsDir: false
    expect(DEFAULT_SETTING_SYNC.profileHotkeys).toBe(true);
    expect(DEFAULT_SETTING_SYNC.quickAddHotkey).toBe(true);
    expect(DEFAULT_SETTING_SYNC.transcribePicks).toBe(false);
  });
});

describe("changed-detection and reset", () => {
  const base: AppSettings = structuredClone(DEFAULT_SETTINGS);

  it("defaults read as unchanged, including absent-means-default transcribe flags", () => {
    for (const d of DEFS) expect(isChanged(base, d), d.id).toBe(false);
    // Absent vs explicitly-default transcribe values compare equal.
    const explicit = { ...base, transcribe: { keepAudioCopies: true, historyRetentionDays: 0 } };
    expect(isChanged(explicit, SETTING.keepAudioCopies)).toBe(false);
    expect(isChanged(explicit, SETTING.transcriptionRetention)).toBe(false);
  });

  it("a changed field marks exactly its owning setting", () => {
    const s = structuredClone(base);
    s.recording.trimSilence = false;
    expect(isChanged(s, SETTING.trimSilence)).toBe(true);
    expect(isChanged(s, SETTING.keepDictationAudio)).toBe(false);
    const changed = DEFS.filter((d) => isChanged(s, d)).map((d) => d.id);
    expect(changed).toEqual(["trimSilence"]);
  });

  it("multi-field settings change when any owned field changes", () => {
    const s = structuredClone(base);
    s.recording.realtimePreviewOnHover = true; // second field of liveTranscript
    expect(isChanged(s, SETTING.liveTranscript)).toBe(true);
  });

  it("patchFor resets every owned field; snapshotOf captures for undo", () => {
    const s = structuredClone(base);
    s.recording.recordingsRetentionDays = 30;
    s.transcribe = { dictationRetentionDays: 99 };
    const snap = snapshotOf(s, [SETTING.dictationRetention]);
    expect(snap.recording?.recordingsRetentionDays).toBe(30);
    expect(snap.transcribe?.dictationRetentionDays).toBe(99);
    const patch = patchFor([SETTING.dictationRetention]);
    expect(patch.recording?.recordingsRetentionDays).toBe(
      DEFAULT_SETTINGS.recording.recordingsRetentionDays,
    );
    expect(patch.transcribe?.dictationRetentionDays).toBe(7); // documented implicit default
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
