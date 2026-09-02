import { describe, expect, it, vi } from "vitest";
import { CONFIG_VERSION } from "./store";
import { ALL_CATEGORIES } from "./sync";
import type { SyncCategory } from "./types";
import type { ImportResult, SyncBlob } from "./syncTypes";

vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return {
    ...mod,
    appVersion: async () => "0.0.0-test",
    syncDeviceInfo: async () => null,
  };
});

// applyImport delegates to the sync engine; keep the real migrator (its output
// is part of the contract under test) but spy on both entry points.
vi.mock("./sync", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./sync")>();
  return {
    ...mod,
    applyBlob: vi.fn(async () => {}),
    migrateBlob: vi.fn(mod.migrateBlob),
  };
});

const allOff = (): Record<SyncCategory, boolean> =>
  Object.fromEntries(ALL_CATEGORIES.map((c) => [c, false])) as Record<SyncCategory, boolean>;

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
    const { buildEnvelope } = await import("./exportImport");
    const env = await buildEnvelope(false);
    expect(env.configVersion).toBe(CONFIG_VERSION);
    expect(env.formatVersion).toBe(1);
  });
  it("carries the Transcribe screen's last-used server, model and language", async () => {
    const { useApp } = await import("./store");
    const s = useApp.getState().settings;
    useApp.setState({ settings: { ...s, transcribe: { ...s.transcribe, backendId: "b1", model: "m", language: "en" } } });
    const { buildEnvelope } = await import("./exportImport");
    const tr = (await buildEnvelope(false)).categories.transcription as Record<string, unknown>;
    expect(tr.backendId).toBe("b1");
    expect(tr.model).toBe("m");
    expect(tr.language).toBe("en");
  });
});

// ── applyImport ────────────────────────────────────────────────────────────
// The import path hands the sync engine a MIGRATED blob, gates the plaintext
// secrets on the backends checkbox, and always applies with the gates
// bypassed (a file import is an explicit act, not a sync round).
describe("applyImport", () => {
  it("refuses while a dictation session is live, without touching the store", async () => {
    const { useApp } = await import("./store");
    const { applyBlob } = await import("./sync");
    vi.mocked(applyBlob).mockClear();
    const prev = useApp.getState().status;
    useApp.setState({ status: "listening" });
    try {
      const { applyImport } = await import("./exportImport");
      await expect(applyImport(allOff(), emptyResult())).rejects.toThrow(/dictating/);
      expect(applyBlob).not.toHaveBeenCalled();
    } finally {
      useApp.setState({ status: prev });
    }
  });

  it("carries the plaintext secrets only when the backends category is selected", async () => {
    const { applyBlob } = await import("./sync");
    const { applyImport } = await import("./exportImport");
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
    const { applyImport } = await import("./exportImport");
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
    const { applyImport } = await import("./exportImport");
    vi.mocked(applyBlob).mockClear();
    const sel = { ...allOff(), general: true };
    await applyImport(sel, emptyResult());
    expect(applyBlob).toHaveBeenCalledTimes(1);
    const [, passedSel, retries, opts] = vi.mocked(applyBlob).mock.calls[0];
    expect(passedSel).toEqual(sel);
    expect(retries).toBe(2);
    expect(opts).toEqual({ ignoreGates: true });
  });
});
