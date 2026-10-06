import { describe, expect, it, vi } from "vitest";
import { deleteFailureMessage, pullNow, pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import type { Backend } from "../types";
import type { SyncBlob } from "./syncTypes";
import { backend } from "./syncTestFixtures";

/** pushNow runs only "in Tauri": force that flag for the sync engine, park the keyring read
 *  composeBlob makes, and record whether a PUT went out. Every other api call keeps its own
 *  (non-Tauri, no-op) module-internal behavior. `keys` answers an unparked keyring read,
 *  `pulled` is what a GET returns, and `pushed` records the last PUT's blob. */
const api = vi.hoisted(() => ({
  park: null as null | Promise<Record<string, string>>,
  keys: null as null | Record<string, string>,
  readCalled: false,
  pushes: 0,
  pushed: null as unknown,
  pulled: null as unknown,
}));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    isTauri: true,
    readBackendKeys: (ids: string[]) => {
      api.readCalled = true;
      return api.park ?? (api.keys ? Promise.resolve(api.keys) : orig.readBackendKeys(ids));
    },
    syncPush: async (args: { blob: unknown }) => {
      api.pushes++;
      api.pushed = args.blob;
      return { ok: true, status: 200, state: { version: 1, updated_ts: 1, device: "me", blob: {} } };
    },
    syncPull: async () => ({ ok: true, status: 200, state: api.pulled }),
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
    const b1 = backend({ hasApiKey: true });
    useApp.setState({ settings, backends: [b1], profiles: [], appRules: [], status: "idle" });
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

// A locked keyring makes composeBlob re-send the SNAPSHOT's backends category (never a keyless
// list). Merged against that, "local unchanged" kept the remote list, and the pull hydrated it
// over the store — silently deleting a backend added here. The category must stay out of the
// apply, and no base may be adopted (the next pull, keyring unlocked, merges it properly).
describe("a pull composed with a degraded keyring", () => {
  it("keeps this device's backends and adopts no base", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
    const b1 = backend({ hasApiKey: true });
    useApp.setState({ settings, backends: [b1], profiles: [], appRules: [], status: "idle" });
    // Seed a base: a clean push with the keyring readable records its blob as the snapshot.
    api.keys = { b1: "sk-secret" };
    try {
      await pushNow(true);
      const base = structuredClone(api.pushed) as SyncBlob;
      expect(base.backends?.secrets).toEqual({ b1: "sk-secret" });

      // Wallet locked; the user adds a backend; a peer changes only `general`.
      api.keys = {};
      const added = { ...b1, id: "b2", name: "added-here", hasApiKey: false } as Backend;
      useApp.setState({ backends: [b1, added] });
      const before = useApp.getState().settings.general.typeAsISpeak;
      const remote = structuredClone(base);
      remote.general = { ...remote.general, typeAsISpeak: !before } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      const pushesBefore = api.pushes;
      await pullNow(true);

      const st = useApp.getState();
      expect(st.backends.map((b) => b.id)).toEqual(["b1", "b2"]); // the local add survived
      expect(st.settings.general.typeAsISpeak).toBe(!before); // everything else still applied
      expect(st.syncStatus).toBe("ok");
      // No base adopted: a forced push still names version 1 (the seeded one) as its base, i.e.
      // the snapshot was not replaced by the peer's version 2.
      api.keys = { b1: "sk-secret" };
      api.pushed = null;
      await pushNow(true);
      expect(api.pushes).toBe(pushesBefore + 1);
      expect((api.pushed as SyncBlob).backends?.list.map((b) => b.id)).toEqual(["b1", "b2"]);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});
