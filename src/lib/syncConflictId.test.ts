import { beforeEach, describe, expect, it } from "vitest";
import {
  getPendingConflict,
  getPendingReview,
  raiseConflictForTests,
  resolveSyncConflicts,
} from "./sync";
import { useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { DEFAULT_SETTING_SYNC } from "./settingsManifest";
import type { Backend } from "./types";

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

function reset() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, sub: { ...DEFAULT_SETTING_SYNC, recordingsDir: DEFAULT_SETTING_SYNC.audioFolder } };
  useApp.setState({ settings, backends: [backend()], profiles: [], appRules: [], status: "idle" });
}

// The conflict dialog's body is keyed on this id: a second conflict must get a
// NEW id so React remounts it with fresh picks — a retained "remote" pick from
// the previous conflict would silently hand the peer a category, no prompt.
describe("pending-conflict identity", () => {
  it("each raised conflict gets a distinct id", () => {
    raiseConflictForTests();
    const first = getPendingConflict();
    raiseConflictForTests();
    const second = getPendingConflict();
    expect(first?.id).toBeTypeOf("number");
    expect(second?.id).not.toBe(first?.id);
  });
});

describe("resolveSyncConflicts", () => {
  beforeEach(reset);

  it("the local side of the security review knows this device's backends", async () => {
    // `c.local` is a COMPOSED blob and omits `backends` whenever the keyring read degraded;
    // read as "this device has no backends", every server backend — including ones held here
    // byte-identically — was a "new backend" and parked sync on a review dialog.
    raiseConflictForTests({
      categories: ["backends"],
      local: {},
      remote: { backends: { list: [backend()] } },
      merged: {},
    });
    await resolveSyncConflicts({ backends: "remote" });
    expect(getPendingReview()).toBeNull(); // b1 is already ours — no consent needed

    reset();
    raiseConflictForTests({
      categories: ["backends"],
      local: {},
      remote: { backends: { list: [backend(), backend({ id: "b2", serverUrl: "http://peer:9" })] } },
      merged: {},
    });
    await resolveSyncConflicts({ backends: "remote" });
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["new-backend"]);
  });

  it("adopting a resolution records the device that wrote it", async () => {
    // The three adopt sites all record the writer of the version being adopted; this one
    // kept naming the PREVIOUS sync's device under "Last synced just now · from X".
    useApp.getState().setSyncRuntime({ lastSyncDevice: "laptop-a" });
    raiseConflictForTests({ remoteDevice: "laptop-b" });
    await resolveSyncConflicts({ general: "remote" });
    expect(useApp.getState().lastSyncDevice).toBe("laptop-b");
  });
});
