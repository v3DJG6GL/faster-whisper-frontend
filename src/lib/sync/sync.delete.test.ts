import { describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  deleteFailureMessage,
  getPendingConflict,
  getPendingReview,
  pullNow,
  pushNow,
  resetSyncState,
  resolveSyncConflicts,
} from "./sync";
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
  /** When set, a GET waits on it before answering with `pulled`. */
  pullPark: null as null | Promise<void>,
  pullCalled: false,
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
    syncPull: async () => {
      api.pullCalled = true;
      if (api.pullPark) await api.pullPark;
      return { ok: true, status: 200, state: api.pulled };
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

  // Resolving a conflict applied with backends ON: `c.local` is the degraded compose, so the
  // resolved doc held the base's list whichever side won and the hydrate deleted b2.
  it("resolving a conflict keeps this device's list", async () => {
    try {
      const { base, before } = await seed();
      const s = useApp.getState().settings;
      const localStart = !s.general.startMinimized;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: localStart } } });
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: peer(base, before, false) };
      await pullNow(true);
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      await resolveSyncConflicts({ general: "remote" });
      const st = useApp.getState();
      expect(st.backends.map((b) => b.id)).toEqual(["b1", "b2"]);
      expect(st.settings.general.typeAsISpeak).toBe(!before);
      expect(st.syncStatus).toBe("ok");
    } finally {
      cleanup();
    }
  });

  // A review raised over a degraded compose held backends out of the apply, but the approval
  // adopted the peer's changed backends category as base — the next unlocked push then
  // reverted the peer's change. It must withhold the base like the paths that raised it.
  it("approving a review whose remote changed backends adopts no base", async () => {
    try {
      const { base, before } = await seed();
      const remote = peer(base, before, true);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("dictation-retention");
      await approvePendingReview();
      const st = useApp.getState();
      expect(st.settings.transcribe?.dictationRetentionDays).toBe(1); // the approved change applied
      expect(st.backends.map((b) => [b.id, b.name])).toEqual([["b1", "local"], ["b2", "added-here"]]);
      expect(st.syncStatus).toBe("error");
      expect(st.syncError).toContain("keyring");
      api.keys = { b1: "sk-secret" };
      await pushNow(true);
      expect(api.pushedBase).toBe(1); // still the seeded base
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

// After a peer's "Delete server copy" the backend answers a stale base with a 409 whose body is the
// zero-state (blob null). Merging `{}` against the old snapshot dropped every unchanged category
// and conflicted the changed ones; the push must re-seed from version 0 like the pull does.
describe("a 409 against a deleted server copy", () => {
  it("re-seeds from version 0 and pushes the full blob", async () => {
    try {
      await resetSyncState();
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
      useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
      api.keys = { b1: "sk-secret" };
      await pushNow(true);
      const full = structuredClone(api.pushed) as SyncBlob;
      const s = useApp.getState().settings;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: !s.general.startMinimized } } });
      api.conflicts = [{ version: 0, updated_ts: null, device: null, blob: null }];
      const pushesBefore = api.pushes;
      await pushNow(true);
      expect(getPendingConflict()).toBeNull();
      // The follow-up push (scheduled at 0 ms) sends the whole document on base 0.
      await vi.waitFor(() => expect(api.pushes).toBe(pushesBefore + 2));
      expect(api.pushedBase).toBe(0);
      const sent = api.pushed as SyncBlob;
      expect(Object.keys(sent).sort()).toEqual(Object.keys(full).sort());
      expect(sent.backends?.secrets).toEqual({ b1: "sk-secret" });
      expect(useApp.getState().syncStatus).toBe("ok");
    } finally {
      api.keys = null;
      api.conflicts = [];
    }
  });
});

// A review adopts no base, so a pull running when the user clicks Apply re-raises the SAME review
// as a new object. The approval waits for that pull, then compared by identity and returned
// silently: the dialog's button came back and nothing was applied.
describe("approving a review while a pull re-raises it", () => {
  it("still applies", async () => {
    await resetSyncState();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
    useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
    api.keys = { b1: "sk-secret" };
    let release: () => void = () => {};
    try {
      await pushNow(true);
      const remote = structuredClone(api.pushed) as SyncBlob;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("dictation-retention");
      api.pullPark = new Promise<void>((r) => (release = r));
      api.pullCalled = false;
      const pulling = pullNow(); // a focus pull, parked on the server
      await vi.waitFor(() => expect(api.pullCalled).toBe(true));
      const approving = approvePendingReview(); // waits for the pull's lock
      release();
      await pulling;
      await approving;
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(1);
    } finally {
      release();
      api.pullPark = null;
      api.keys = null;
      api.pulled = null;
    }
  });
});
