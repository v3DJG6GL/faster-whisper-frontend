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
  pushedBase: null as null | number,
  pulled: null as unknown,
  /** Answered (once each, in order) with a 409 carrying this state instead of a 200. */
  conflicts: [] as unknown[],
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
    syncPush: async (args: { blob: unknown; baseVersion: number }) => {
      api.pushes++;
      api.pushed = args.blob;
      api.pushedBase = args.baseVersion;
      const conflict = api.conflicts.shift();
      if (conflict) return { ok: false, status: 409, conflict };
      return { ok: true, status: 200, state: { version: args.baseVersion + 1, updated_ts: 1, device: "me", blob: {} } };
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
// apply. The remote becomes the base only when it left the category alone (nothing is lost);
// otherwise no base is adopted and the status says the keyring is locked, rather than "ok"
// while every later push stalls behind a 409.
describe("a sync composed with a degraded keyring", () => {
  /** Seed a version-1 base from a clean push, then lock the wallet and add a backend here. */
  async function seed(): Promise<{ base: SyncBlob; before: boolean }> {
    await resetSyncState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
    const b1 = backend({ hasApiKey: true });
    useApp.setState({ settings, backends: [b1], profiles: [], appRules: [], status: "idle" });
    api.keys = { b1: "sk-secret" };
    await pushNow(true);
    const base = structuredClone(api.pushed) as SyncBlob;
    expect(base.backends?.secrets).toEqual({ b1: "sk-secret" });
    api.keys = {};
    const added = { ...b1, id: "b2", name: "added-here", hasApiKey: false } as Backend;
    useApp.setState({ backends: [b1, added] });
    return { base, before: useApp.getState().settings.general.typeAsISpeak };
  }
  /** The peer's blob: `general` flipped, and optionally b1 renamed. */
  function peer(base: SyncBlob, before: boolean, renameB1: boolean): SyncBlob {
    const remote = structuredClone(base);
    remote.general = { ...remote.general, typeAsISpeak: !before } as never;
    if (renameB1) remote.backends!.list = remote.backends!.list.map((b) => ({ ...b, name: "renamed-by-peer" }));
    return remote;
  }
  const cleanup = () => {
    api.keys = null;
    api.pulled = null;
    api.conflicts = [];
  };

  it("a pull that left backends alone keeps this device's list and adopts the base", async () => {
    try {
      const { base, before } = await seed();
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: peer(base, before, false) };
      await pullNow(true);
      const st = useApp.getState();
      expect(st.backends.map((b) => b.id)).toEqual(["b1", "b2"]); // the local add survived
      expect(st.settings.general.typeAsISpeak).toBe(!before); // everything else still applied
      expect(st.syncStatus).toBe("ok");
      // Base adopted: the next push (keyring unlocked) names the peer's version 2 and carries
      // this device's list.
      api.keys = { b1: "sk-secret" };
      await pushNow(true);
      expect(api.pushedBase).toBe(2);
      expect((api.pushed as SyncBlob).backends?.list.map((b) => b.id)).toEqual(["b1", "b2"]);
    } finally {
      cleanup();
    }
  });

  it("a pull that changed backends adopts no base and says the keyring is locked", async () => {
    try {
      const { base, before } = await seed();
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: peer(base, before, true) };
      await pullNow(true);
      const st = useApp.getState();
      expect(st.backends.map((b) => [b.id, b.name])).toEqual([["b1", "local"], ["b2", "added-here"]]);
      expect(st.settings.general.typeAsISpeak).toBe(!before);
      expect(st.syncStatus).toBe("error");
      expect(st.syncError).toContain("keyring");
      api.keys = { b1: "sk-secret" };
      await pushNow(true);
      expect(api.pushedBase).toBe(1); // still the seeded base
    } finally {
      cleanup();
    }
  });

  it("a 409 that left backends alone adopts the merge and pushes on the new base", async () => {
    try {
      const { base, before } = await seed();
      api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: peer(base, before, false) }];
      const pushesBefore = api.pushes;
      await pushNow(true);
      const st = useApp.getState();
      expect(api.pushes).toBe(pushesBefore + 2);
      expect(api.pushedBase).toBe(5);
      // The locked keyring never pushes a reverted list: the re-push carries the base's category.
      expect((api.pushed as SyncBlob).backends?.list.map((b) => b.id)).toEqual(["b1"]);
      expect(st.backends.map((b) => b.id)).toEqual(["b1", "b2"]);
      expect(st.settings.general.typeAsISpeak).toBe(!before);
      expect(st.syncStatus).toBe("ok");
    } finally {
      cleanup();
    }
  });

  it("a 409 that changed backends stops with a keyring error instead of a silent ok", async () => {
    try {
      const { base, before } = await seed();
      api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: peer(base, before, true) }];
      const pushesBefore = api.pushes;
      await pushNow(true);
      const st = useApp.getState();
      expect(api.pushes).toBe(pushesBefore + 1);
      expect(st.backends.map((b) => [b.id, b.name])).toEqual([["b1", "local"], ["b2", "added-here"]]);
      expect(st.syncStatus).toBe("error");
      expect(st.syncError).toContain("keyring");
    } finally {
      cleanup();
    }
  });
});
