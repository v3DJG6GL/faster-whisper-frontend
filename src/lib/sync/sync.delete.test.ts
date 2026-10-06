import { describe, expect, it, vi } from "vitest";
import { deleteFailureMessage, pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Backend } from "../types";

/** pushNow runs only "in Tauri": force that flag for the sync engine, park the keyring read
 *  composeBlob makes, and record whether a PUT went out. Every other api call keeps its own
 *  (non-Tauri, no-op) module-internal behavior. */
const api = vi.hoisted(() => ({
  park: null as null | Promise<Record<string, string>>,
  readCalled: false,
  pushes: 0,
}));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    isTauri: true,
    readBackendKeys: (ids: string[]) => {
      api.readCalled = true;
      return api.park ?? orig.readBackendKeys(ids);
    },
    syncPush: async () => {
      api.pushes++;
      return { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "me", blob: {} } };
    },
  };
});

// "Delete server copy" used to discard the transport result entirely: a failed
// delete looked like success, cleared the local base, and the next push merged
// the "deleted" doc right back. The message helper is the testable half of the
// fix — every failure shape names the consequence, and server-authored text is
// defanged before display.
describe("deleteFailureMessage", () => {
  it("unreachable server (status 0) says the settings were not deleted", () => {
    const msg = deleteFailureMessage({ ok: false, status: 0, error: "connect ECONNREFUSED" });
    expect(msg).toContain("not deleted");
    expect(msg).toContain("ECONNREFUSED");
  });
  it("auth failure names the API key, not the raw status", () => {
    expect(deleteFailureMessage({ ok: false, status: 401 })).toContain("API key");
    expect(deleteFailureMessage({ ok: false, status: 403 })).toContain("API key");
  });
  it("other statuses are surfaced with the code", () => {
    expect(deleteFailureMessage({ ok: false, status: 500 })).toContain("(500)");
  });
  it("defangs control characters and bidi overrides in server text", () => {
    const msg = deleteFailureMessage({ ok: false, status: 0, error: "bad\u0007\u202Etext" });
    expect(msg).not.toContain("\u0007");
    expect(msg).not.toContain("\u202E");
  });
});

// A push parked on a slow/locked keyring (composeBlob's read, up to 10 s) must not still PUT once
// the user pressed "Delete server copy" (or turned sync off) meanwhile — it would recreate the
// copy just deleted, API keys included.
describe("a push superseded while composing", () => {
  it("never sends", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
    const backend = {
      id: "b1",
      name: "local",
      serverUrl: "http://10.0.0.2:8000",
      hasApiKey: true,
      model: "large-v3",
      endpoint: "transcriptions",
      language: "auto",
      responseFormat: "verbose_json",
      kind: "faster-whisper",
    } as unknown as Backend;
    useApp.setState({ settings, backends: [backend], profiles: [], appRules: [], status: "idle" });
    let release: (v: Record<string, string>) => void = () => {};
    api.park = new Promise((r) => (release = r));
    try {
      const pushing = pushNow(true);
      await vi.waitFor(() => expect(api.readCalled).toBe(true));
      await resetSyncState(); // "Delete server copy" while the keyring read is parked
      release({ b1: "sk-secret" });
      await pushing;
    } finally {
      api.park = null;
    }
    expect(api.pushes).toBe(0);
  });
});
