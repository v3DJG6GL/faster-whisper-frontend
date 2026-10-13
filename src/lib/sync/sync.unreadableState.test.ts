// sync-state.json exists but can't be read at launch (a Windows AV lock): the engine must not
// start from "no state" and save that over the merge base, version and stashed-key ids it holds.
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";

describe("an unreadable sync-state.json", () => {
  afterEach(() => {
    vi.doUnmock("../api");
    vi.doUnmock("../persistence");
    vi.resetModules();
  });

  it("pauses sync for the launch and is never saved over", async () => {
    const saveSyncState = vi.fn(async () => {});
    const syncPull = vi.fn(async () => ({ ok: false, status: 0, error: "unreachable" }));
    const syncPush = vi.fn(async () => ({ ok: false, status: 0, error: "unreachable" }));
    vi.resetModules();
    vi.doMock("../persistence", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../persistence")>()),
      configReady: Promise.resolve(),
    }));
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      isTauri: true,
      loadSyncState: async () => {
        throw "sync state unreadable: Permission denied";
      },
      saveSyncState,
      syncDeviceInfo: async () => ({ deviceId: "d1", hostname: "me", platform: "linux" }),
      readBackendKeys: async () => ({}),
      setBackendKey: async () => {},
      deleteBackendKey: async () => {},
      syncPull,
      syncPush,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await import("./sync");
    const store = (await import("../store")).useApp;
    const s = structuredClone(DEFAULT_SETTINGS);
    s.sync = { ...s.sync!, enabled: true, backendId: "b1" };
    store.setState({ settings: s, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });

    await expect(engine.initSync()).rejects.toBe("sync state unreadable: Permission denied");
    expect(store.getState().syncStatus).toBe("error");
    expect(store.getState().syncError).toContain("sync-state.json) could not be read");

    // A manual Pull / Push and "Delete server copy"'s reset: none may write the file.
    await engine.pullNow(true);
    await engine.pushNow(true);
    await engine.resetSyncState();
    expect(saveSyncState).not.toHaveBeenCalled();
    expect(syncPull).not.toHaveBeenCalled();
    expect(syncPush).not.toHaveBeenCalled();
    expect(store.getState().syncStatus).toBe("error");
  });
});
