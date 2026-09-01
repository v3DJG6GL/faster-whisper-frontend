import { describe, expect, it, vi } from "vitest";
import { CONFIG_VERSION } from "./store";

vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return {
    ...mod,
    appVersion: async () => "0.0.0-test",
    syncDeviceInfo: async () => null,
  };
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
