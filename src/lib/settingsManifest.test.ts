import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTING_SYNC,
  DEFS,
  GENERAL_COVERAGE,
  LOCAL,
  LOGGING_COVERAGE,
  RECORDING_COVERAGE,
  SETTING,
  SYNC_GROUPS,
  TOP_COVERAGE,
  TRANSCRIBE_COVERAGE,
  settingsOfGroup,
  type FieldRef,
} from "./settingsManifest";
import { DICTATION_HISTORY_FIELDS, FILE_TRANSCRIPTION_FIELDS, TRANSCRIPTION_FIELDS, TRANSCRIPTION_PICK_FIELDS } from "./sync/syncTypes";


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

  it("machineSpecific / localOnly settings default to sync OFF", () => {
    for (const d of DEFS) {
      if (d.machineSpecific || d.localOnly) {
        expect(DEFAULT_SETTING_SYNC[d.id as keyof typeof DEFAULT_SETTING_SYNC], d.id).toBe(false);
      }
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

  it("every Transcribe setting with a Sync switch is in a list that actually travels", () => {
    // A manifest row promises its fields sync; for settings.transcribe that only holds when the
    // key is in one of the field lists compose/apply allowlist (five export / link-video keys
    // once showed a switch and never moved).
    const travels = new Set<string>([
      ...TRANSCRIPTION_FIELDS, ...FILE_TRANSCRIPTION_FIELDS, ...DICTATION_HISTORY_FIELDS, ...TRANSCRIPTION_PICK_FIELDS,
    ]);
    const missing = DEFS.filter((d) => !d.localOnly)
      .flatMap((d) => (d.fields ?? []) as FieldRef[])
      .filter((f) => f.slice === "transcribe" && !travels.has(f.key))
      .map((f) => f.key);
    expect(missing).toEqual([]);
  });

  it("the appearance settings form their own Sync group card", () => {
    // Theme, Signal colour and Motion sit under their own Settings tab and the Sync tab
    // mirrors that: one "Appearance" card, not three rows buried in General.
    const ids = settingsOfGroup("appearance").map((d) => d.id).sort();
    expect(ids).toEqual(["accentHue", "accentMotion", "theme"]);
    expect(settingsOfGroup("general").some((d) => d.id === "theme")).toBe(false);
  });

  it("the retired insertTiming has no sync row", () => {
    // The field is kept in the type for rollbacks but has no UI control anywhere, so a
    // per-setting sync switch for it would advertise something the user cannot change.
    expect(DEFS.some((d) => d.fields.some((f) => f.slice === "general" && f.key === "insertTiming"))).toBe(false);
  });

  it("the clipboard-history privacy setting syncs by default, under Dictation → Insertion", () => {
    // A preference about the user's data, not about this machine: turning it on at one desk
    // should reach the others, so it is deliberately NOT machineSpecific.
    expect(DEFAULT_SETTING_SYNC.excludeFromClipboardHistory).toBe(true);
    expect(SETTING.excludeFromClipboardHistory.section).toBe("Insertion");
    expect(settingsOfGroup("dictation").some((d) => d.id === "excludeFromClipboardHistory")).toBe(true);
    expect(GENERAL_COVERAGE.excludeFromClipboardHistory).toBe("excludeFromClipboardHistory");
  });

  it("legacy sub-toggle semantics carry over (defaults preserve today's behavior)", () => {
    // The four pre-manifest sub-toggles keep their defaults under new ids.
    expect(DEFAULT_SETTING_SYNC.audioFolder).toBe(false); // was recordingsDir: false
    expect(DEFAULT_SETTING_SYNC.profileHotkeys).toBe(true);
    expect(DEFAULT_SETTING_SYNC.quickAddHotkey).toBe(true);
    expect(DEFAULT_SETTING_SYNC.transcribePicks).toBe(false);
  });

  it("the translation-model pick syncs with the per-machine Transcribe picks, not the portable defaults", () => {
    // It names a model on the saved backend's server and Transcribe seeds/clears it with
    // backendId, so it must sit behind the same default-off switch.
    expect(TRANSCRIBE_COVERAGE.translationModel).toBe("transcribePicks");
    expect(SETTING.transcribePicks.fields.some((f) => f.key === "translationModel")).toBe(true);
    expect(SETTING.translateTo.fields.some((f) => f.key === "translationModel")).toBe(false);
    expect((TRANSCRIPTION_PICK_FIELDS as readonly string[]).includes("translationModel")).toBe(true);
    expect((TRANSCRIPTION_FIELDS as readonly string[]).includes("translationModel")).toBe(false);
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
    // A manifest-era map: the chip member it lacks follows chip's CURRENT state (on, via
    // autoHideToEdge), not the frozen legacy OFF toggle.
    expect(g.liveTranscript).toBe(DEFAULT_SETTING_SYNC.liveTranscript);
  });

  it("a setting added after the manifest follows its category's current gates, not a frozen legacy OFF toggle", async () => {
    const { completeGates, settingsOfCategory } = await import("./settingsManifest");
    // The user had Profiles OFF before the manifest, then turned every Profiles switch back ON;
    // `sync.categories.profiles` has no writer any more, so it stays false.
    const withProfiles = (on: boolean) => {
      const saved: Partial<Record<string, boolean>> = { ...DEFAULT_SETTING_SYNC };
      for (const d of settingsOfCategory("profiles")) saved[d.id] = on;
      delete saved.profileInsertion; // shipped in a later version than the saved map
      return saved;
    };
    expect(completeGates(withProfiles(true), { profiles: false }).profileInsertion).toBe(true);
    // Still off in the saved gates: the new member stays off too.
    expect(completeGates(withProfiles(false), { profiles: false }).profileInsertion).toBe(false);
    // A list category's state is its list switch alone.
    expect(completeGates({ ...withProfiles(true), profileList: false }, undefined).profileInsertion).toBe(false);
    // A scalar category with no saved member at all still honours the legacy toggle.
    const noChip: Partial<Record<string, boolean>> = { ...DEFAULT_SETTING_SYNC };
    for (const d of settingsOfCategory("chip")) delete noChip[d.id];
    expect(completeGates(noChip, { chip: false }).liveTranscript).toBe(false);
  });

  it("a pre-manifest sub map refines only within an ON category (its defaults were auto-persisted)", async () => {
    const { completeGates } = await import("./settingsManifest");
    const { catsFromGates } = await import("./sync/syncGates");
    const legacy = { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: false };
    const g = completeGates(legacy, { general: true, dictionary: false });
    expect(g.quickAddHotkey).toBe(false); // the OFF dictionary fold wins over the auto-persisted true
    expect(catsFromGates(g).dictionary).toBe(false);
    expect(g.profileHotkeys).toBe(true); // ON category: the legacy key still applies
    const r = completeGates({ ...legacy, recordingsDir: true }, { recording: false });
    expect(r.audioFolder).toBe(false); // recordingsDir → audioFolder, but the category is OFF
    expect(completeGates({ ...legacy, recordingsDir: true }, { recording: true }).audioFolder).toBe(true);
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

  it("a pre-manifest sub map does not re-enable the quick-add chord of an OFF pre-split General", async () => {
    const { withSettingsDefaults } = await import("./store");
    const sub = withSettingsDefaults({
      sync: {
        categories: { general: false },
        sub: { recordingsDir: false, profileHotkeys: true, quickAddHotkey: true, transcribePicks: false },
      },
    }).sync!.sub!;
    expect(sub.quickAddHotkey).toBe(false);
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
    expect(sub.latchAutoStop).toBe(DEFAULT_SETTING_SYNC.handsFreeAutoStop);
    const vals = Object.values(DEFAULT_SETTING_SYNC);
    expect(vals.some((v) => !v)).toBe(true); // a boolean "sync everything" master can never read on by default
    expect(vals.some((v) => v)).toBe(true);
  });
});
