import { describe, expect, it, vi } from "vitest";
import { CONFIG_VERSION } from "../store";
import { categorySelection } from "./sync";
import type { SyncCategory } from "../types";
import type { ImportResult, SyncBlob } from "./syncTypes";

vi.mock("../api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../api")>();
  const readBackendKeys = vi.fn(async (_ids: string[]): Promise<Record<string, string>> => ({}));
  return {
    ...mod,
    appVersion: async () => "0.0.0-test",
    syncDeviceInfo: async () => null,
    exportSettingsFile: vi.fn(async () => undefined),
    readBackendKeys,
    // An id the mocked read leaves out FAILED to read (a locked wallet), it is not absent.
    readBackendKeyStates: vi.fn(async (ids: string[]) => {
      const keys = await readBackendKeys(ids);
      return { keys, unreadable: ids.filter((id) => !Object.prototype.hasOwnProperty.call(keys, id)) };
    }),
  };
});

// applyImport delegates to the sync engine; keep the real migrator (its output
// is part of the contract under test) but spy on both entry points.
vi.mock("./sync", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./sync")>();
  return {
    ...mod,
    applyBlob: vi.fn(async () => true),
    migrateBlob: vi.fn(mod.migrateBlob),
  };
});

const allOff = (): Record<SyncCategory, boolean> => categorySelection(false);

const emptyResult = (): ImportResult => ({
  formatVersion: 1,
  configVersion: CONFIG_VERSION,
  appVersion: "0.0.0-test",
  hostname: "",
  platform: "",
  createdAt: new Date().toISOString(),
  categories: {} as SyncBlob,
  secrets: {},
  hasSecrets: false,
  warnings: [],
});

// The envelope's declared schema version is what lets an OLDER build warn
// "this file is newer than me" before serde silently drops unknown settings.
// It was frozen at 2 while the app moved to 3 — pin it to CONFIG_VERSION so a
// future bump can never leave the envelope behind again.
describe("buildEnvelope", () => {
  it("stamps the app's CONFIG_VERSION, not a frozen literal", async () => {
    const { buildEnvelope } = await import("./settingsFile");
    const env = await buildEnvelope(false);
    expect(env.configVersion).toBe(CONFIG_VERSION);
    expect(env.formatVersion).toBe(1);
  });
  it("carries the Transcribe screen's last-used server, model and language", async () => {
    const { useApp } = await import("../store");
    const s = useApp.getState().settings;
    useApp.setState({ settings: { ...s, transcribe: { ...s.transcribe, backendId: "b1", model: "m", language: "en" } } });
    const { buildEnvelope } = await import("./settingsFile");
    const tr = (await buildEnvelope(false)).categories.transcription as Record<string, unknown>;
    expect(tr.backendId).toBe("b1");
    expect(tr.model).toBe("m");
    expect(tr.language).toBe("en");
  });
});

// A locked keyring degrades the composed backends to the keyless list; the
// export must report that instead of a plain "Exported" for a backup the user
// asked to carry the keys.
describe("exportToFile", () => {
  it("reports keysMissing when the keys were asked for but could not be read", async () => {
    const { useApp } = await import("../store");
    const api = await import("../api");
    const { exportToFile } = await import("./settingsFile");
    const prev = useApp.getState().backends;
    const b0 = { ...(prev[0] ?? {}), id: "b1", hasApiKey: true } as (typeof prev)[number];
    useApp.setState({ backends: [b0] });
    try {
      vi.mocked(api.readBackendKeys).mockResolvedValueOnce({});
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: true });
      const calls = vi.mocked(api.exportSettingsFile).mock.calls;
      const env = calls[calls.length - 1][1] as { categories: SyncBlob };
      expect(env.categories.backends?.secrets).toBeUndefined();

      vi.mocked(api.readBackendKeys).mockResolvedValueOnce({ b1: "sk-1" });
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: false });

      // Keys not asked for: nothing is missing.
      await expect(exportToFile("/tmp/x.json", false)).resolves.toEqual({ keysMissing: false });
    } finally {
      useApp.setState({ backends: prev });
    }
  });

  // The verdict follows the list the file was built from, not the store after the write: a sync
  // pull landing during the export can add or drop a key in between.
  it("judges keysMissing on the exported list, not on a store a pull changed meanwhile", async () => {
    const { useApp } = await import("../store");
    const api = await import("../api");
    const { exportToFile } = await import("./settingsFile");
    const prev = useApp.getState().backends;
    const b0 = { ...(prev[0] ?? {}), id: "b1", hasApiKey: true } as (typeof prev)[number];
    try {
      // Keyed list, keyring read failed, and the key is gone by the time the file is written.
      useApp.setState({ backends: [b0] });
      vi.mocked(api.readBackendKeys).mockResolvedValueOnce({});
      vi.mocked(api.exportSettingsFile).mockImplementationOnce(async () => {
        useApp.setState({ backends: [{ ...b0, hasApiKey: false }] });
      });
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: true });

      // Keyless list (nothing to carry), and a key arrives while the file is written.
      useApp.setState({ backends: [{ ...b0, hasApiKey: false }] });
      vi.mocked(api.exportSettingsFile).mockImplementationOnce(async () => {
        useApp.setState({ backends: [b0] });
      });
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: false });
    } finally {
      useApp.setState({ backends: prev });
    }
  });

  // A flag whose key the keyring reports ABSENT (config copied from another machine, wallet reset)
  // goes into the file as keyless, which it is: nothing failed to read, so nothing is missing.
  it("does not report keysMissing for a stale flag the keyring reports absent", async () => {
    const { useApp } = await import("../store");
    const api = await import("../api");
    const { exportToFile } = await import("./settingsFile");
    const prev = useApp.getState().backends;
    const b0 = { ...(prev[0] ?? {}), id: "b1", hasApiKey: true } as (typeof prev)[number];
    useApp.setState({ backends: [b0] });
    try {
      vi.mocked(api.readBackendKeyStates).mockResolvedValueOnce({ keys: {}, unreadable: [] });
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: false });
      const calls = vi.mocked(api.exportSettingsFile).mock.calls;
      const env = calls[calls.length - 1][1] as { categories: SyncBlob };
      expect(env.categories.backends?.list.map((b) => b.hasApiKey)).toEqual([false]);

      vi.mocked(api.readBackendKeyStates).mockResolvedValueOnce({ keys: {}, unreadable: ["b1"] });
      await expect(exportToFile("/tmp/x.json", true)).resolves.toEqual({ keysMissing: true });
    } finally {
      useApp.setState({ backends: prev });
    }
  });
});

// ── stripMachineFolders ─────────────────────────────────────────────────────
// Every one-shot restore (import, Restore from server, onboarding) applies with
// the gates bypassed, so the peer's folder paths must be gone before the apply.
describe("stripMachineFolders", () => {
  it("drops the three folder paths and keeps every other recording/logging key", async () => {
    const { stripMachineFolders } = await import("./settingsFile");
    const input = {
      recording: { recordingsDir: "C:\\rec", audioBaseDir: "C:\\audio", saveRecordings: true, keepDays: 30 },
      logging: { logDir: "C:\\logs", level: "debug", keepDays: 7 },
      general: { theme: "dark" },
    } as unknown as SyncBlob;
    const out = stripMachineFolders(input) as unknown as Record<string, Record<string, unknown>>;
    expect(out.recording).toEqual({ saveRecordings: true, keepDays: 30 });
    expect(out.logging).toEqual({ level: "debug", keepDays: 7 });
    expect(out.general).toEqual({ theme: "dark" });
    // Pure: the caller's blob still carries its folders.
    const orig = input as unknown as Record<string, Record<string, unknown>>;
    expect(orig.recording.recordingsDir).toBe("C:\\rec");
    expect(orig.logging.logDir).toBe("C:\\logs");
  });

  it("passes a blob without recording/logging through unchanged", async () => {
    const { stripMachineFolders } = await import("./settingsFile");
    const input = { general: { theme: "dark" } } as unknown as SyncBlob;
    expect(stripMachineFolders(input)).toEqual(input);
  });
});

// ── applyImport ────────────────────────────────────────────────────────────
// The import path hands the sync engine a MIGRATED blob, gates the plaintext
// secrets on the backends checkbox, and always applies with the gates
// bypassed (a file import is an explicit act, not a sync round).
describe("applyImport", () => {
  it("refuses while a dictation session is live, without touching the store", async () => {
    const { useApp } = await import("../store");
    const { applyBlob } = await import("./sync");
    vi.mocked(applyBlob).mockClear();
    const prev = useApp.getState().status;
    useApp.setState({ status: "listening" });
    try {
      const { applyImport } = await import("./settingsFile");
      await expect(applyImport(allOff(), emptyResult())).rejects.toThrow(/dictating/);
      expect(applyBlob).not.toHaveBeenCalled();
    } finally {
      useApp.setState({ status: prev });
    }
  });

  it("carries the plaintext secrets only when the backends category is selected", async () => {
    const { applyBlob } = await import("./sync");
    const { applyImport } = await import("./settingsFile");
    const result: ImportResult = {
      ...emptyResult(),
      categories: { backends: { list: [] } } as unknown as SyncBlob,
      secrets: { b1: "sk-secret" },
    };

    vi.mocked(applyBlob).mockClear();
    await applyImport({ ...allOff(), backends: false }, result);
    const off = vi.mocked(applyBlob).mock.calls[0][0];
    expect((off.backends as unknown as Record<string, unknown> | undefined)?.secrets).toBeUndefined();

    vi.mocked(applyBlob).mockClear();
    await applyImport({ ...allOff(), backends: true }, result);
    const on = vi.mocked(applyBlob).mock.calls[0][0];
    expect((on.backends as unknown as Record<string, unknown>).secrets).toEqual({ b1: "sk-secret" });
  });

  it("migrates a pre-split file: chip fields leave recording, the quick-add chord leaves general", async () => {
    const { applyBlob, migrateBlob } = await import("./sync");
    const { applyImport } = await import("./settingsFile");
    vi.mocked(applyBlob).mockClear();
    const preSplit = {
      recording: { indicatorPosition: "top-right", persistentDock: true },
      general: { quickAddHotkey: ["ControlLeft", "KeyJ"] },
    } as unknown as SyncBlob;
    await applyImport(allOff(), { ...emptyResult(), categories: preSplit });

    // The pre-split shape is what reaches the migrator...
    expect(migrateBlob).toHaveBeenCalled();
    const calls = vi.mocked(migrateBlob).mock.calls;
    const migIn = calls[calls.length - 1][0] as unknown as Record<string, Record<string, unknown>>;
    expect(migIn.recording.indicatorPosition).toBe("top-right");
    expect(migIn.general.quickAddHotkey).toEqual(["ControlLeft", "KeyJ"]);

    // ...and the migrated shape is what reaches the apply.
    const blob = vi.mocked(applyBlob).mock.calls[0][0] as unknown as Record<string, Record<string, unknown>>;
    expect(blob.chip?.indicatorPosition).toBe("top-right");
    expect(blob.chip?.persistentDock).toBe(true);
    expect(blob.recording).not.toHaveProperty("indicatorPosition");
    expect(blob.dictionary?.quickAddHotkey).toEqual(["ControlLeft", "KeyJ"]);
    expect(blob.general).not.toHaveProperty("quickAddHotkey");
  });

  it("always applies with the sub-toggle gates bypassed", async () => {
    const { applyBlob } = await import("./sync");
    const { applyImport } = await import("./settingsFile");
    vi.mocked(applyBlob).mockClear();
    const sel = { ...allOff(), general: true };
    await applyImport(sel, emptyResult());
    expect(applyBlob).toHaveBeenCalledTimes(1);
    const [, passedSel, retries, opts] = vi.mocked(applyBlob).mock.calls[0];
    expect(passedSel).toEqual(sel);
    expect(retries).toBe(2);
    expect(opts).toEqual({ ignoreGates: true });
  });

  // ignoreGates opens the folder gates, so a hand-edited file naming folder
  // paths would move this device's recordings and logs — the dialog promises
  // folders are never imported.
  it("strips the machine folder paths before the gate-bypassing apply", async () => {
    const { applyBlob } = await import("./sync");
    const { applyImport } = await import("./settingsFile");
    vi.mocked(applyBlob).mockClear();
    const categories = {
      recording: { recordingsDir: "/evil/rec", audioBaseDir: "/evil/audio", saveRecordings: true },
      logging: { logDir: "/evil/logs", keepDays: 7 },
    } as unknown as SyncBlob;
    await applyImport({ ...allOff(), recording: true, logging: true }, { ...emptyResult(), categories });
    const blob = vi.mocked(applyBlob).mock.calls[0][0] as unknown as Record<string, Record<string, unknown>>;
    expect(blob.recording).not.toHaveProperty("recordingsDir");
    expect(blob.recording).not.toHaveProperty("audioBaseDir");
    expect(blob.recording.saveRecordings).toBe(true);
    expect(blob.logging).not.toHaveProperty("logDir");
    expect(blob.logging.keepDays).toBe(7);
  });

  // The preview dialog shows an error on false — a deferred apply or exhausted
  // retries — so the boolean is part of the contract, not a pass-through detail.
  it("reports whether the apply landed", async () => {
    const { applyBlob } = await import("./sync");
    const { applyImport } = await import("./settingsFile");
    await expect(applyImport(allOff(), emptyResult())).resolves.toBe(true);
    vi.mocked(applyBlob).mockResolvedValueOnce(false);
    await expect(applyImport(allOff(), emptyResult())).resolves.toBe(false);
  });
});
