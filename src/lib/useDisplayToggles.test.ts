import { describe, expect, it } from "vitest";
import { useApp } from "./store";
import { patchTranscribe } from "./useDisplayToggles";

describe("patchTranscribe", () => {
  it("reads the store at call time — two patches in one tick both stick", () => {
    patchTranscribe({ showTimestamps: true });
    patchTranscribe({ exportFormat: "vtt" });
    const t = useApp.getState().settings.transcribe;
    expect(t?.showTimestamps).toBe(true);
    expect(t?.exportFormat).toBe("vtt");
  });
});
