import { describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  deleteFailureMessage,
  dismissSyncConflict,
  getPendingConflict,
  getPendingReview,
  pullNow,
  pushNow,
  raiseConflictForTests,
  rejectPendingReview,
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
  /** When set, `park` holds only the keyring read with this 1-based number (counted in `reads`). */
  parkOn: null as null | number,
  reads: 0,
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
  /** Every keyring write, in order (the real one is a no-op outside Tauri). */
  keyWrites: [] as [string, string][],
  /** Every keyring delete, in order (the real one is a no-op outside Tauri). */
  keyDeletes: [] as string[],
}));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    isTauri: true,
    readBackendKeys: (ids: string[]) => {
      api.readCalled = true;
      api.reads++;
      const park = api.parkOn === null || api.reads === api.parkOn ? api.park : null;
      return park ?? (api.keys ? Promise.resolve(api.keys) : orig.readBackendKeys(ids));
    },
    setBackendKey: async (id: string, key: string) => {
      api.keyWrites.push([id, key]);
    },
    deleteBackendKey: async (id: string) => {
      api.keyDeletes.push(id);
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

  // The raise-time degraded flag withheld the base even after the user stopped syncing the server
  // list, saying backend changes are "on hold" for a category this device no longer syncs.
  it("approving a degraded review after turning server-list sync off adopts the base", async () => {
    try {
      const { base, before } = await seed();
      const remote = peer(base, before, true);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("dictation-retention");
      const settings = structuredClone(useApp.getState().settings);
      settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, backendList: false } };
      useApp.setState({ settings });
      await approvePendingReview();
      const st = useApp.getState();
      expect(st.settings.transcribe?.dictationRetentionDays).toBe(1);
      expect(st.backends.map((b) => [b.id, b.name])).toEqual([["b1", "local"], ["b2", "added-here"]]);
      expect(st.syncError ?? "").not.toContain("keyring");
      api.keys = { b1: "sk-secret" };
      await pushNow(true);
      expect(api.pushedBase).toBe(2); // the peer's version became the base
    } finally {
      cleanup();
    }
  });

  // Raised with the keyring readable, approved after it locked: the approval's compose carried
  // the base's backends category, the merge read it as "local unchanged", and the apply wrote
  // the base / peer list over every backend added here since.
  it("approving a review after the keyring locked keeps this device's list", async () => {
    for (const renameB1 of [false, true]) {
      try {
        await resetSyncState();
        const settings = structuredClone(DEFAULT_SETTINGS);
        settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
        const b1 = backend({ hasApiKey: true });
        useApp.setState({ settings, backends: [b1], profiles: [], appRules: [], status: "idle" });
        api.keys = { b1: "sk-secret" };
        await pushNow(true);
        const base = structuredClone(api.pushed) as SyncBlob;
        const before = useApp.getState().settings.general.typeAsISpeak;
        const remote = peer(base, before, renameB1);
        remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
        api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
        await pullNow(true);
        expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("dictation-retention");
        // Now add a backend here and lock the wallet before approving.
        const added = { ...b1, id: "b2", name: "added-here", hasApiKey: false } as Backend;
        useApp.setState({ backends: [...useApp.getState().backends, added] });
        api.keys = {};
        await approvePendingReview();
        // Judged under the categories the apply runs with: the held-out backends (the peer's
        // stored key) must not relist a review whose rows can never land.
        expect(getPendingReview()).toBeNull();
        const st = useApp.getState();
        expect(st.settings.transcribe?.dictationRetentionDays).toBe(1); // the approved change applied
        // A rename is not held back: the raise already applied it, before the add here.
        const b1Name = renameB1 ? "renamed-by-peer" : "local";
        expect(st.backends.map((b) => [b.id, b.name])).toEqual([["b1", b1Name], ["b2", "added-here"]]);
        api.keys = { b1: "sk-secret" };
        await pushNow(true);
        if (renameB1) {
          // The peer changed backends: no base adopted, and the status says why.
          expect(api.pushedBase).toBe(1);
        } else {
          expect(api.pushedBase).toBe(2);
          expect((api.pushed as SyncBlob).backends?.list.map((b) => b.id)).toEqual(["b1", "b2"]);
        }
      } finally {
        cleanup();
      }
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

/** Seed a version-1 base from a clean push with sync on and the keyring answering. */
async function seedBase(): Promise<SyncBlob> {
  await resetSyncState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
  useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
  api.keys = { b1: "sk-secret" };
  await pushNow(true);
  return structuredClone(api.pushed) as SyncBlob;
}

/** A synced chip setting (not machine-specific, so the chip category carries it). */
function bumpChipScale(): number {
  const s = useApp.getState().settings;
  const next = s.recording.chipScale === 1.5 ? 1.25 : 1.5;
  useApp.setState({ settings: { ...s, recording: { ...s.recording, chipScale: next } } });
  return next;
}

// After a peer's "Delete server copy" this device re-seeds from version 0, and numbering restarts
// at 1 — so a review raised against the deleted doc's v5 was never dropped (1 < 5) and never moot:
// the dialog sat beside "Synced", and approving it re-landed the deleted doc's change.
describe("a pending review when the server copy is gone", () => {
  /** Seed a base, then raise a review at v5 (a retention change is always held for consent). */
  async function raiseAtV5(): Promise<number | undefined> {
    const base = await seedBase();
    const before = useApp.getState().settings.transcribe?.dictationRetentionDays;
    const risky = structuredClone(base);
    risky.recording = { ...risky.recording, dictationRetentionDays: 1 } as never;
    api.pulled = { version: 5, updated_ts: 5, device: "peer", blob: risky };
    await pullNow(true);
    expect(getPendingReview()).not.toBeNull();
    return before;
  }
  it("is dropped by a pull that finds no server document", async () => {
    try {
      const before = await raiseAtV5();
      api.pulled = { version: 0, updated_ts: null, device: null, blob: null };
      await pullNow(true);
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().syncStatus).toBe("ok");
      await approvePendingReview(); // a stray click on the stale dialog
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  // The peer that deleted usually re-seeds at once: a device pulling after that never sees the
  // empty document, only a NEW one at a version below the prompt's.
  it("is dropped by a pull that finds the re-created document at a lower version", async () => {
    try {
      const before = await raiseAtV5();
      const reseeded = structuredClone(api.pulled as { blob: SyncBlob }).blob;
      reseeded.recording = { ...reseeded.recording, dictationRetentionDays: before } as never;
      api.pulled = { version: 1, updated_ts: 6, device: "peer", blob: reseeded };
      await pullNow(true);
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().syncStatus).toBe("ok");
      await approvePendingReview(); // a stray click on the stale dialog
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  it("is dropped by a focus pull whose re-created document reached this base's version, which is then reconciled", async () => {
    try {
      const before = await raiseAtV5();
      const reseeded = structuredClone(api.pulled as { blob: SyncBlob }).blob;
      reseeded.recording = { ...reseeded.recording, dictationRetentionDays: before } as never;
      const peerType = !useApp.getState().settings.general.typeAsISpeak;
      reseeded.general = { ...reseeded.general, typeAsISpeak: peerType } as never;
      api.pulled = { version: 1, updated_ts: 6, device: "peer", blob: reseeded }; // base is v1 too
      await pullNow();
      expect(getPendingReview()).toBeNull();
      await approvePendingReview();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
      // The dead base is forgotten, so the matching number is not "nothing new": the re-seeded
      // document is reconciled first-contact (the differing category is asked about), and no
      // push blind-overwrites the peer's re-seed at base 1.
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      const pushesBefore = api.pushes;
      await pushNow();
      expect(api.pushes === pushesBefore || api.pushedBase !== 1).toBe(true);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  // A re-seed can also climb back to EXACTLY the prompt's number: same version, another write
  // stamp. Approving then adopted the dead document's blob as the base at that number.
  it("is dropped by a pull whose re-created document reached the review's own version", async () => {
    try {
      const before = await raiseAtV5(); // the review was raised at v5, stamp 5
      const reseeded = structuredClone(api.pulled as { blob: SyncBlob }).blob;
      reseeded.recording = { ...reseeded.recording, dictationRetentionDays: before } as never;
      const peerType = !useApp.getState().settings.general.typeAsISpeak;
      reseeded.general = { ...reseeded.general, typeAsISpeak: peerType } as never;
      api.pulled = { version: 5, updated_ts: 9, device: "peer", blob: reseeded };
      await pullNow();
      expect(getPendingReview()).toBeNull();
      await approvePendingReview(); // a stray click on the stale dialog
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
      // The dead base is forgotten: the re-seed is reconciled first-contact (the differing
      // category is asked about), not 3-way merged against the deleted document's v1 and applied.
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(!peerType);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  it("is dropped by a push whose 409 carries the re-created document at a lower version", async () => {
    try {
      const before = await raiseAtV5();
      const reseeded = structuredClone(api.pulled as { blob: SyncBlob }).blob;
      reseeded.recording = { ...reseeded.recording, dictationRetentionDays: before } as never;
      api.conflicts = [{ version: 1, updated_ts: 6, device: "peer", blob: reseeded }];
      await pushNow(true);
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()).toBeNull();
      await approvePendingReview();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
    } finally {
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
  // The push composed before it learned the document was re-created: its gated-off fields were
  // filled from the dead snapshot, and a first-contact merge took them for local edits.
  it("recomposes after a 409 on a re-created document, so dead pass-through values stay off the server", async () => {
    try {
      const base = await seedBase();
      api.pulled = { version: 5, updated_ts: 5, device: "peer", blob: base };
      await pullNow(true); // a clean pull: the base is now v5
      const s = useApp.getState().settings;
      const dead = (base.general as { soundEffects: boolean }).soundEffects;
      useApp.setState({
        settings: {
          ...s,
          general: { ...s.general, soundEffects: !dead },
          sync: { ...s.sync!, sub: { ...s.sync!.sub!, soundCues: false } },
        },
      });
      const reseeded = structuredClone(base);
      delete (reseeded.general as { soundEffects?: boolean }).soundEffects; // the peer gates it off too
      api.conflicts = [{ version: 1, updated_ts: 6, device: "peer", blob: reseeded }];
      await pushNow(true);
      expect(getPendingConflict()).toBeNull();
      expect(api.pushedBase).toBe(1);
      expect((api.pushed as SyncBlob).general).not.toHaveProperty("soundEffects");
    } finally {
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
  // The forget clears the stash itself; its state write then saw the old stash ids still set and
  // deleted the same keyring entry again — a second 10 s wait under a locked wallet.
  it("clears the snapshot's keyring stash once when the server copy is gone", async () => {
    try {
      await seedBase();
      expect(api.keyWrites.length).toBeGreaterThan(0); // the base's keys were stashed
      api.keyDeletes = [];
      api.pulled = { version: 0, updated_ts: null, device: null, blob: null };
      await pullNow(true);
      expect(api.keyDeletes).toHaveLength(1);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  it("is dropped by a push whose 409 finds no server document", async () => {
    try {
      await raiseAtV5();
      api.conflicts = [{ version: 0, updated_ts: null, device: null, blob: null }];
      await pushNow(true);
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().syncStatus).toBe("ok");
    } finally {
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
});

// With the dead base forgotten there was nothing to pass through: the gates deleted every field
// this device does not sync, the first-contact merge took the re-seed's copy of them for a
// conflicting edit, and "Keep mine" pushed them erased — the server's API keys among them.
describe("a re-created document reconciled with no base", () => {
  /** Seed a base, adopt a clean v5, then gate `sub` off here: a re-seed at v1 forgets the base. */
  async function atV5(sub: Record<string, boolean>): Promise<SyncBlob> {
    const base = await seedBase();
    api.pulled = { version: 5, updated_ts: 5, device: "peer", blob: base };
    await pullNow(true);
    const s = useApp.getState().settings;
    useApp.setState({ settings: { ...s, sync: { ...s.sync!, sub: { ...s.sync!.sub!, ...sub } } } });
    return base;
  }
  it("passes a gated-off setting the re-seed keeps through instead of conflicting it", async () => {
    try {
      const base = await atV5({ soundCues: false });
      const peer = (base.general as { soundEffects: boolean }).soundEffects;
      const s = useApp.getState().settings;
      useApp.setState({ settings: { ...s, general: { ...s.general, soundEffects: !peer } } });
      api.pulled = { version: 1, updated_ts: 6, device: "peer", blob: structuredClone(base) };
      await pullNow();
      expect(getPendingConflict()).toBeNull();
      await pushNow(true);
      expect(api.pushedBase).toBe(1);
      expect((api.pushed as SyncBlob).general).toHaveProperty("soundEffects", peer);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  it("passes the re-seed's API keys through while the API keys gate is off", async () => {
    try {
      const base = await atV5({ apiKeys: false });
      const reseeded = structuredClone(base);
      reseeded.backends = { ...reseeded.backends!, secrets: { b1: "sk-peer" } };
      api.pulled = { version: 1, updated_ts: 6, device: "peer", blob: reseeded };
      await pullNow();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      await pushNow(true);
      expect(api.pushedBase).toBe(1);
      expect((api.pushed as SyncBlob).backends?.secrets).toEqual({ b1: "sk-peer" });
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  // Server versions only grow, but a re-seed restarts at 1 and can climb back to exactly this
  // base's number. The same version under a different write stamp is a different document: it
  // took the "nothing new" shortcut, and the next push at that base overwrote the peer's re-seed.
  it("treats a re-seed that lands on the base's own version as a new document", async () => {
    try {
      const base = await seedBase(); // v1, written at updated_ts 1
      const reseeded = structuredClone(base);
      const peerType = !useApp.getState().settings.general.typeAsISpeak;
      reseeded.general = { ...reseeded.general, typeAsISpeak: peerType } as never;
      api.pulled = { version: 1, updated_ts: 7, device: "peer", blob: reseeded };
      await pullNow();
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      bumpChipScale();
      const pushesBefore = api.pushes;
      await pushNow();
      expect(api.pushes === pushesBefore || api.pushedBase !== 1).toBe(true);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
  // A persisted base's stamp goes through serde_json's best-effort float parse and can come back
  // one ULP off `time.time()`'s 17 digits: after a restart the unchanged server copy then read as
  // a re-seed and the live base was forgotten. Only a real re-write moves the stamp that far.
  it("keeps the base when the same version's stamp differs only by float noise", async () => {
    try {
      const stamp = 1759900000.123958;
      const base = await seedBase();
      api.pulled = { version: 5, updated_ts: stamp, device: "peer", blob: base };
      await pullNow(true);
      const reseeded = structuredClone(base);
      const peerType = !useApp.getState().settings.general.typeAsISpeak;
      reseeded.general = { ...reseeded.general, typeAsISpeak: peerType } as never;
      const offByUlp = stamp + 2 ** -22;
      expect(offByUlp).not.toBe(stamp);
      api.pulled = { version: 5, updated_ts: offByUlp, device: "peer", blob: reseeded };
      await pullNow();
      expect(getPendingConflict()).toBeNull(); // not reconciled first-contact
      bumpChipScale();
      await pushNow();
      expect(api.pushedBase).toBe(5);
      // A stamp a second away is another write at that number: the base is forgotten.
      const pushed = structuredClone(api.pushed) as SyncBlob;
      api.pulled = { version: 7, updated_ts: stamp + 1, device: "peer", blob: pushed };
      await pullNow(true);
      expect(getPendingConflict()).toBeNull();
      api.pulled = { version: 7, updated_ts: stamp + 2, device: "peer", blob: { ...pushed, general: reseeded.general } };
      await pullNow();
      expect(getPendingConflict()?.categories).toEqual(["general"]);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// The raise's store signature reads the keyring (up to 10 s) AFTER the epoch check: a "Delete
// server copy" / sync off during that wait dropped every prompt, and the raise then put the old
// server's review back up — approving it adopted that server's blob and version as the new base.
describe("a review raised across a reset", () => {
  it("is not revived when the reset lands during the signature's keyring read", async () => {
    let release: (v: Record<string, string>) => void = () => {};
    try {
      const base = await seedBase();
      const risky = structuredClone(base);
      risky.recording = { ...risky.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: risky };
      // Count the keyring reads one raise makes: the signature's is the last.
      api.reads = 0;
      await pullNow(true);
      const reads = api.reads;
      expect(getPendingReview()).not.toBeNull();
      rejectPendingReview();
      api.reads = 0;
      api.parkOn = reads;
      api.park = new Promise((r) => (release = r));
      const pulling = pullNow(true);
      await vi.waitFor(() => expect(api.reads).toBe(reads));
      await resetSyncState();
      release({ b1: "sk-secret" });
      await pulling;
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().syncStatus).not.toBe("error");
    } finally {
      release({ b1: "sk-secret" });
      api.park = null;
      api.parkOn = null;
      api.keys = null;
      api.pulled = null;
    }
  });
});

// A review or conflict adopts no base, so only the user's answer cleared it: after the peer took
// the change back (a clean pull at a NEWER version) the dialog stayed up next to "Synced", and its
// Apply re-landed the withdrawn change and moved the base backwards.
describe("a pending review the server moved past", () => {
  it("is dropped by the clean pull that adopts the newer version", async () => {
    try {
      const base = await seedBase();
      const before = useApp.getState().settings.transcribe?.dictationRetentionDays;
      const risky = structuredClone(base);
      risky.recording = { ...risky.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: risky };
      await pullNow(true);
      expect(getPendingReview()).not.toBeNull();
      api.pulled = { version: 3, updated_ts: 3, device: "peer", blob: base }; // taken back
      await pullNow(true);
      expect(getPendingReview()).toBeNull();
      await approvePendingReview(); // a stray click on the stale dialog
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(before);
      await pushNow(true);
      expect(api.pushedBase).toBe(3);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// The resolve / approve applied the blob merged against the raise-time local: an edit made here
// while the dialog waited, to a category only this device changed, was hydrated back.
describe("an edit made while a sync prompt waits", () => {
  it("survives resolving the conflict", async () => {
    try {
      const base = await seedBase();
      const s = useApp.getState().settings;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: !s.general.startMinimized } } });
      const remote = structuredClone(base);
      remote.general = { ...remote.general, typeAsISpeak: !s.general.typeAsISpeak } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      const scale = bumpChipScale();
      await resolveSyncConflicts({ general: "remote" });
      expect(getPendingConflict()).toBeNull();
      expect(useApp.getState().settings.recording.chipScale).toBe(scale);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(!s.general.typeAsISpeak);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });

  it("survives approving the review", async () => {
    try {
      const base = await seedBase();
      const remote = structuredClone(base);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()).not.toBeNull();
      const scale = bumpChipScale();
      await approvePendingReview();
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(1);
      expect(useApp.getState().settings.recording.chipScale).toBe(scale);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// The approval re-merged against the live compose but put the reviewed value back on every
// category that conflicted — including ones the raise had already applied, where the only way to
// conflict is an edit made on top of the peer's value while the dialog waited. The apply reverted
// it, the base moved to the peer's version and the follow-up push shipped the revert.
describe("approving a review after editing a category the peer changed", () => {
  /** The peer flips general.typeAsISpeak and lowers the dictation retention (held for review). */
  async function raise(): Promise<{ base: SyncBlob; peerTyping: boolean }> {
    const base = await seedBase();
    const remote = structuredClone(base);
    const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
    remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
    remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
    api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
    await pullNow(true);
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
    expect(useApp.getState().settings.general.typeAsISpeak).toBe(peerTyping); // general applied
    expect(getPendingReview()?.restApplied).toBe(true);
    return { base, peerTyping };
  }
  const toggleStartMinimized = (): boolean => {
    const s = useApp.getState().settings;
    const next = !s.general.startMinimized;
    useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: next } } });
    return next;
  };
  const cleanup = () => {
    api.keys = null;
    api.pulled = null;
    api.conflicts = [];
  };

  it("keeps the edit, adopts the peer's version and pushes the edit", async () => {
    try {
      const { peerTyping } = await raise();
      const mine = toggleStartMinimized();
      const pushesBefore = api.pushes;
      await approvePendingReview();
      const st = useApp.getState();
      expect(getPendingReview()).toBeNull();
      expect(st.settings.general.startMinimized).toBe(mine);
      expect(st.settings.general.typeAsISpeak).toBe(peerTyping);
      expect(st.settings.transcribe?.dictationRetentionDays).toBe(1);
      // The follow-up push (scheduled at 0 ms) carries the edit on the adopted base.
      await vi.waitFor(() => expect(api.pushes).toBe(pushesBefore + 1));
      expect(api.pushedBase).toBe(2);
      expect((api.pushed as SyncBlob).general?.startMinimized).toBe(mine);
    } finally {
      cleanup();
    }
  });

  it("asks when the edit is to the held-back category itself", async () => {
    try {
      const { base } = await raise();
      const s = useApp.getState().settings;
      const days = base.recording?.handsFreeAutoStopMin === 45 ? 50 : 45;
      useApp.setState({ settings: { ...s, recording: { ...s.recording, handsFreeAutoStopMin: days } } });
      await approvePendingReview();
      // Neither the approval nor the edit may win silently: a conflict at the peer's version.
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()?.categories).toEqual(["recording"]);
      const st = useApp.getState();
      expect(st.settings.recording.handsFreeAutoStopMin).toBe(days);
      expect(st.settings.transcribe?.dictationRetentionDays).not.toBe(1);
      // Taking the peer's side goes back through the security review, not straight in.
      await resolveSyncConflicts({ recording: "remote" });
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      await approvePendingReview(); // no further edit: the pick stands, no second conflict
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(1);
    } finally {
      cleanup();
    }
  });

  // The edit's debounced push 409s at the review's version and raises a conflict NEXT to the
  // review (same version, so neither raise drops the other). Approving adopted the base but left
  // the conflict up beside "Synced"; its "keep mine" then hit the moot guard and was dropped.
  it("also answers a conflict raised at the same version", async () => {
    try {
      const { peerTyping } = await raise();
      const mine = toggleStartMinimized();
      api.conflicts = [api.pulled];
      await pushNow();
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      expect(getPendingReview()).not.toBeNull();
      await approvePendingReview();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().settings.general.startMinimized).toBe(mine);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(peerTyping);
      await vi.waitFor(() => expect(api.pushedBase).toBe(2));
      expect((api.pushed as SyncBlob).general?.startMinimized).toBe(mine);
      expect(useApp.getState().syncStatus).toBe("ok");
    } finally {
      cleanup();
    }
  });
});

// An approval that finds rows the user never saw re-raises the review as "relisted", and the
// dialog says the list changed. A review adopts no base, so the next push / focus pull re-raised
// the same list without the flag and the notice vanished while the dialog stayed up.
describe("a relisted review", () => {
  it("keeps its notice when the same list is raised again", async () => {
    const setServerAddresses = (on: boolean) => {
      const settings = structuredClone(useApp.getState().settings);
      settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
      useApp.setState({ settings });
    };
    try {
      const base = await seedBase();
      setServerAddresses(false);
      const remote = structuredClone(base);
      remote.backends = { ...remote.backends!, list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })) };
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      setServerAddresses(true);
      await approvePendingReview();
      expect(getPendingReview()?.relisted).toBe(true);
      await pullNow(true); // a focus pull re-raises the same review
      expect(getPendingReview()?.changes.map((c) => c.kind).sort()).toEqual(["dictation-retention", "server-url"]);
      expect(getPendingReview()?.relisted).toBe(true);
      expect(useApp.getState().backends[0].serverUrl).toBe("http://10.0.0.2:8000");
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// The approval kept the LIVE value of every applied category that conflicted, taking any
// difference for a user edit. A field the raise-time apply stripped (its gate was off) makes the
// live compose differ too once the gate is turned on, with no edit: the repoint was never
// relisted and the follow-up push sent this device's address over the peer's.
describe("approving a review after turning a sync gate on", () => {
  const setServerAddresses = (on: boolean) => {
    const settings = structuredClone(useApp.getState().settings);
    settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
    useApp.setState({ settings });
  };
  /** The peer renames b1 AND repoints it, and lowers the retention (held for review). The
   *  "Server addresses" gate is off here, so the rename applies and the repoint is stripped. */
  async function raise(): Promise<string> {
    const base = await seedBase();
    setServerAddresses(false);
    const localUrl = useApp.getState().backends[0].serverUrl;
    const remote = structuredClone(base);
    remote.backends = {
      ...remote.backends!,
      list: remote.backends!.list.map((b) => ({ ...b, name: "renamed-by-peer", serverUrl: "http://evil:9" })),
    };
    remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
    api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
    await pullNow(true);
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
    expect(useApp.getState().backends[0].name).toBe("renamed-by-peer");
    expect(useApp.getState().backends[0].serverUrl).toBe(localUrl);
    return localUrl;
  }
  const cleanup = () => {
    api.keys = null;
    api.pulled = null;
    api.conflicts = [];
  };

  it("relists the repoint instead of pushing this device's address over it", async () => {
    try {
      const localUrl = await raise();
      setServerAddresses(true);
      const pushesBefore = api.pushes;
      await approvePendingReview();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()?.relisted).toBe(true);
      expect(getPendingReview()?.changes.map((c) => c.kind).sort()).toEqual(["dictation-retention", "server-url"]);
      expect(useApp.getState().backends[0].serverUrl).toBe(localUrl);
      expect(api.pushes).toBe(pushesBefore); // nothing went over the peer's repoint
      // Approving the list the user has now seen lands the repoint, nothing else asks.
      await approvePendingReview();
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()).toBeNull();
      expect(useApp.getState().backends[0].serverUrl).toBe("http://evil:9");
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("asks when the user also edited that category", async () => {
    try {
      const localUrl = await raise();
      setServerAddresses(true);
      useApp.setState({ backends: useApp.getState().backends.map((b) => ({ ...b, name: "renamed-here" })) });
      const pushesBefore = api.pushes;
      await approvePendingReview();
      // Keeping the live list would push this device's address over the peer's repoint;
      // putting the peer's back would drop the rename. Neither wins silently.
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()?.categories).toContain("backends");
      const st = useApp.getState();
      expect(st.backends[0].name).toBe("renamed-here");
      expect(st.backends[0].serverUrl).toBe(localUrl);
      expect(api.pushes).toBe(pushesBefore);
    } finally {
      cleanup();
    }
  });
});

// A review raised on a push's SECOND 409 recorded the first attempt's merge (the reassigned
// push blob) as "this device", not a compose of it: an approval with no edit could find the
// held-back category "edited" and turn into a conflict.
describe("a review raised on a push's second 409", () => {
  it("approves without a conflict when nothing was edited", async () => {
    try {
      const base = await seedBase();
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      const v2 = structuredClone(base);
      v2.general = { ...v2.general, typeAsISpeak: peerTyping } as never;
      const v3 = structuredClone(v2);
      v3.recording = { ...v3.recording, dictationRetentionDays: 1 } as never;
      api.conflicts = [
        { version: 2, updated_ts: 2, device: "peer", blob: v2 },
        { version: 3, updated_ts: 3, device: "peer", blob: v3 },
      ];
      await pushNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(peerTyping);
      await approvePendingReview();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().settings.transcribe?.dictationRetentionDays).toBe(1);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(peerTyping);
    } finally {
      api.keys = null;
      api.conflicts = [];
    }
  });
});

const setServerAddressesGate = (on: boolean) => {
  const settings = structuredClone(useApp.getState().settings);
  settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
  useApp.setState({ settings });
};

// The edit check compared the store without the keyring: the store's backends carry only
// `hasApiKey`, so a key rotated while a backends review waited read as "not edited". The approval
// put the raise-time key back, relisted it as an "api-key" row for the user's own backend as if
// the peer had changed it, and a second approval wrote the old key over the rotation.
describe("approving a review after rotating an API key", () => {
  it("asks instead of relisting the old key", async () => {
    try {
      const base = await seedBase();
      setServerAddressesGate(true);
      const localUrl = useApp.getState().backends[0].serverUrl;
      const remote = structuredClone(base);
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })),
      };
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["server-url"]);
      api.keys = { b1: "sk-rotated" }; // Backends → new key for b1 while the review waits
      api.keyWrites = [];
      const pushesBefore = api.pushes;
      await approvePendingReview();
      // No relisted api-key row: the rotation is the user's own edit, so ask.
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()?.categories).toContain("backends");
      expect(api.keyWrites.filter(([id]) => id === "b1")).toEqual([]);
      expect(useApp.getState().backends[0].serverUrl).toBe(localUrl);
      expect(api.pushes).toBe(pushesBefore);
    } finally {
      api.keys = null;
      api.pulled = null;
      api.keyWrites = [];
    }
  });
});

// The gate check compared the WHOLE gate set, and a relisted review kept it: once a gate had
// been turned on (the reason for the relist), any edit to an applied category that the peer also
// changed turned every later approval into a conflict, though nothing in it had been stripped.
describe("approving a relisted review after an ordinary edit", () => {
  it("lands without asking", async () => {
    try {
      const base = await seedBase();
      setServerAddressesGate(false);
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      const remote = structuredClone(base);
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })),
      };
      remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      setServerAddressesGate(true);
      await approvePendingReview();
      expect(getPendingReview()?.relisted).toBe(true);
      // An edit to general (applied at the raise; its gates never moved) on top of the peer's.
      const s = useApp.getState().settings;
      const mine = !s.general.startMinimized;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: mine } } });
      await approvePendingReview();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      const st = useApp.getState();
      expect(st.settings.general.startMinimized).toBe(mine);
      expect(st.settings.general.typeAsISpeak).toBe(peerTyping);
      expect(st.backends[0].serverUrl).toBe("http://evil:9");
      expect(st.settings.transcribe?.dictationRetentionDays).toBe(1);
    } finally {
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
});

// The pin applies only together with the backends list, so a review holding backends back also
// withheld the peer's pin — yet the raise recorded the dictionary as applied. A dictionary edit
// made while the review waited then kept the live dictionary (old pin) without asking, the base
// was adopted and the follow-up push overwrote the peer's pin.
describe("approving a backends review after a dictionary edit", () => {
  it("asks instead of dropping the peer's withheld pin", async () => {
    try {
      const base = await seedBase();
      setServerAddressesGate(true);
      const pinBefore = useApp.getState().settings.quickAddList ?? null;
      const remote = structuredClone(base);
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })),
      };
      remote.dictionary = { ...remote.dictionary, quickAddList: { backendId: "b1", slug: "peer-list" } };
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["server-url"]);
      expect(useApp.getState().settings.quickAddList ?? null).toEqual(pinBefore); // withheld
      // A dictionary edit here while the review waits: a new quick-add chord.
      const s = useApp.getState().settings;
      useApp.setState({
        settings: { ...s, general: { ...s.general, quickAddHotkey: ["ControlLeft", "KeyQ"] } },
      });
      const pushesBefore = api.pushes;
      await approvePendingReview();
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()?.categories).toContain("dictionary");
      expect(api.pushes).toBe(pushesBefore);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// The approval read its store signature AFTER the compose it is paired with, and a relist kept
// that signature: an edit landing during the first keyring wait was in the new signature but not
// in the relisted blob, so the next approval took it as "not edited" and put the peer's value
// back over it.
describe("an edit landing during an approval's keyring wait", () => {
  it("survives the relist and the next approval", async () => {
    let release: (v: Record<string, string>) => void = () => {};
    try {
      const base = await seedBase();
      setServerAddressesGate(false);
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      const remote = structuredClone(base);
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })),
      };
      remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      setServerAddressesGate(true);
      // Park only the approval's FIRST keyring read; edit general while it waits.
      api.readCalled = false;
      api.park = new Promise((r) => (release = r));
      const approving = approvePendingReview();
      await vi.waitFor(() => expect(api.readCalled).toBe(true));
      api.park = null;
      const s = useApp.getState().settings;
      const mine = !s.general.startMinimized;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: mine } } });
      release({ b1: "sk-secret" });
      await approving;
      expect(getPendingReview()?.relisted).toBe(true);
      await approvePendingReview();
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      const st = useApp.getState();
      expect(st.settings.general.startMinimized).toBe(mine);
      expect(st.settings.general.typeAsISpeak).toBe(peerTyping);
    } finally {
      release({ b1: "sk-secret" });
      api.park = null;
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
  // The signature is now read first: the same edit is then in the compose only, and an approval
  // that applies straight away must keep it rather than take the category as "not edited".
  it("survives an approval that applies straight away", async () => {
    let release: (v: Record<string, string>) => void = () => {};
    try {
      const base = await seedBase();
      setServerAddressesGate(true);
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      const remote = structuredClone(base);
      remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      api.readCalled = false;
      api.park = new Promise((r) => (release = r));
      const approving = approvePendingReview();
      await vi.waitFor(() => expect(api.readCalled).toBe(true));
      api.park = null;
      const s = useApp.getState().settings;
      const mine = !s.general.startMinimized;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: mine } } });
      release({ b1: "sk-secret" });
      await approving;
      expect(getPendingConflict()).toBeNull();
      expect(getPendingReview()).toBeNull();
      const st = useApp.getState();
      expect(st.settings.general.startMinimized).toBe(mine);
      expect(st.settings.general.typeAsISpeak).toBe(peerTyping);
      expect(st.settings.transcribe?.dictationRetentionDays).toBe(1);
    } finally {
      release({ b1: "sk-secret" });
      api.park = null;
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
});

// The raisers recorded `applied` from the categories they ASKED applyBlob to land, ignoring its
// answer. A pull raised while dictating lands nothing (applyBlob refuses and parks a re-pull), so
// when that re-pull never replaced the review, an edit to a category the peer changed read as
// "on top of the applied peer value": the approval kept the live value, adopted the peer's base
// and the follow-up push shipped the edit over the peer's change without asking.
describe("approving a review raised while dictating", () => {
  it("asks about a category the peer changed and the user edited since", async () => {
    try {
      const base = await seedBase();
      const remote = structuredClone(base);
      const localTyping = useApp.getState().settings.general.typeAsISpeak;
      remote.general = { ...remote.general, typeAsISpeak: !localTyping } as never;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      useApp.setState({ status: "recording" as never });
      try {
        await pullNow(true);
      } finally {
        useApp.setState({ status: "idle" }); // the re-pull at the session's end never lands
      }
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      expect(useApp.getState().settings.general.typeAsISpeak).toBe(localTyping); // nothing landed
      expect(getPendingReview()?.restApplied).toBe(false); // the dialog must not say "applied already"
      const s = useApp.getState().settings;
      const mine = !s.general.startMinimized;
      useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: mine } } });
      const pushesBefore = api.pushes;
      await approvePendingReview();
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()?.categories).toEqual(["general"]);
      expect(useApp.getState().settings.general.startMinimized).toBe(mine);
      expect(api.pushes).toBe(pushesBefore);
    } finally {
      api.keys = null;
      api.pulled = null;
      api.conflicts = [];
    }
  });
});

// Turning a category off does not supersede a pending review (only an ON transition re-pulls),
// and the approval composed, judged and applied under the raise-time categories: approving a
// server-list review after opting out of server-list sync still landed the peer's whole list.
describe("approving a backends review after turning the server-list gate off", () => {
  it("leaves this device's list alone", async () => {
    try {
      const base = await seedBase();
      setServerAddressesGate(true);
      const before = useApp.getState().backends.map((b) => [b.name, b.serverUrl]);
      const remote = structuredClone(base);
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, name: "renamed-by-peer", serverUrl: "http://evil:9" })),
      };
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["server-url"]);
      const settings = structuredClone(useApp.getState().settings);
      settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, backendList: false } };
      useApp.setState({ settings });
      await approvePendingReview();
      expect(getPendingReview()).toBeNull();
      expect(getPendingConflict()).toBeNull();
      expect(useApp.getState().backends.map((b) => [b.name, b.serverUrl])).toEqual(before);
    } finally {
      api.keys = null;
      api.pulled = null;
    }
  });
});

// While a prompt waits no base is adopted, so ANY store edit runs a push that finds nothing new
// to send — and its hash shortcut wrote "ok" over the prompt's notice while the dialog stayed up.
describe("a no-op push while a sync prompt waits", () => {
  it("keeps the review's notice", async () => {
    try {
      const base = await seedBase();
      const remote = structuredClone(base);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()).not.toBeNull();
      const pushesBefore = api.pushes;
      await pushNow();
      expect(api.pushes).toBe(pushesBefore); // the hash shortcut, not a 409 re-raise
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toContain("review it in Settings → Sync");
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
    }
  });

  // A pull refused while dictating adopts no base either, so no dropSupersededPending ran: its
  // bare "ok" said "Synced" next to the still-open review.
  it("keeps the review's notice through a pull refused while dictating", async () => {
    try {
      const base = await seedBase();
      const remote = structuredClone(base);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()).not.toBeNull();
      // The peer reverted the retention and changed something ordinary: nothing to review, but
      // the apply is refused while a session runs.
      const next = structuredClone(base);
      next.general = { ...next.general, typeAsISpeak: !useApp.getState().settings.general.typeAsISpeak } as never;
      api.pulled = { version: 3, updated_ts: 3, device: "peer", blob: next };
      useApp.setState({ status: "recording" as never });
      try {
        await pullNow(true);
      } finally {
        useApp.setState({ status: "idle" });
      }
      expect(getPendingReview()).not.toBeNull();
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toContain("review it in Settings → Sync");
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
    }
  });

  // A push 409ing next to a review raises a conflict at the review's own version, so both wait:
  // closing one wrote a blank status over the other's notice while its dialog stayed up.
  async function raiseBoth(): Promise<void> {
    const base = await seedBase();
    const remote = structuredClone(base);
    remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
    api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
    await pullNow(true);
    expect(getPendingReview()).not.toBeNull();
    raiseConflictForTests({ remoteVersion: 2 });
    expect(getPendingReview()).not.toBeNull();
    expect(getPendingConflict()).not.toBeNull();
  }

  it("keeps the review's notice when the conflict next to it is dismissed", async () => {
    try {
      await raiseBoth();
      dismissSyncConflict();
      expect(getPendingReview()).not.toBeNull();
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toContain("review it in Settings → Sync");
    } finally {
      api.keys = null;
      api.pulled = null;
      dismissSyncConflict();
      rejectPendingReview();
    }
  });

  it("keeps the conflict's notice when the review next to it is rejected", async () => {
    try {
      await raiseBoth();
      rejectPendingReview();
      expect(getPendingConflict()).not.toBeNull();
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toContain("resolve the conflict in Settings → Sync");
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
      dismissSyncConflict();
    }
  });

  // The dialogs read the prompts through non-reactive getters and re-rendered only on a status
  // change — but closing one prompt next to its sibling writes the sibling's notice, unchanged,
  // so the closed dialog stayed up and its buttons did nothing. Every prompt change bumps a seq.
  it("tells the dialogs a review was rejected while the conflict's notice stays", async () => {
    try {
      await raiseBoth();
      const { syncStatus, syncError, syncPromptSeq } = useApp.getState();
      rejectPendingReview();
      expect(getPendingReview()).toBeNull();
      expect(useApp.getState().syncStatus).toBe(syncStatus);
      expect(useApp.getState().syncError).toBe(syncError);
      expect(useApp.getState().syncPromptSeq).toBeGreaterThan(syncPromptSeq);
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
      dismissSyncConflict();
    }
  });

  it("tells the dialogs a conflict was dismissed while the review's notice stays", async () => {
    try {
      // The review raised last, so its notice is the one showing.
      const base = await seedBase();
      raiseConflictForTests({ remoteVersion: 2 });
      const remote = structuredClone(base);
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()).not.toBeNull();
      expect(getPendingConflict()).not.toBeNull();
      const { syncStatus, syncError, syncPromptSeq } = useApp.getState();
      expect(syncError).toContain("review it in Settings → Sync");
      dismissSyncConflict();
      expect(getPendingConflict()).toBeNull();
      expect(useApp.getState().syncStatus).toBe(syncStatus);
      expect(useApp.getState().syncError).toBe(syncError);
      expect(useApp.getState().syncPromptSeq).toBeGreaterThan(syncPromptSeq);
    } finally {
      api.keys = null;
      api.pulled = null;
      dismissSyncConflict();
      rejectPendingReview();
    }
  });
});

// A focus pull while dictating re-raises the same review with an apply that was refused: it
// replaced the raise's record of what landed, so the dialog said nothing was applied yet although
// the rest of the update already had (and the approval re-asked over categories that landed).
describe("a review re-raised by a pull refused while dictating", () => {
  it("keeps the record of the earlier raise's apply", async () => {
    try {
      const base = await seedBase();
      const remote = structuredClone(base);
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.restApplied).toBe(true);
      useApp.setState({ status: "recording" as never });
      try {
        await pullNow(true);
      } finally {
        useApp.setState({ status: "idle" });
      }
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      expect(getPendingReview()?.restApplied).toBe(true);
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
    }
  });

  // The keep was tied to the same rows: a gate turned on (or an edit) since changes the list, not
  // what the earlier apply landed, so the dialog said nothing was applied although most of it had.
  it("keeps it when the re-raise lists different rows", async () => {
    try {
      const base = await seedBase();
      setServerAddressesGate(true);
      const remote = structuredClone(base);
      const peerTyping = !useApp.getState().settings.general.typeAsISpeak;
      remote.general = { ...remote.general, typeAsISpeak: peerTyping } as never;
      remote.backends = {
        ...remote.backends!,
        list: remote.backends!.list.map((b) => ({ ...b, serverUrl: "http://evil:9" })),
      };
      remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
      api.pulled = { version: 2, updated_ts: 2, device: "peer", blob: remote };
      await pullNow(true);
      expect(getPendingReview()?.changes.map((c) => c.kind).sort()).toEqual(["dictation-retention", "server-url"]);
      expect(getPendingReview()?.restApplied).toBe(true); // the general change landed
      // While dictating, this device takes the peer's address itself: the repoint row goes.
      useApp.setState({ status: "recording" as never });
      try {
        useApp.setState({ backends: useApp.getState().backends.map((b) => ({ ...b, serverUrl: "http://evil:9" })) });
        await pullNow(true);
      } finally {
        useApp.setState({ status: "idle" });
      }
      expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["dictation-retention"]);
      expect(getPendingReview()?.restApplied).toBe(true);
    } finally {
      api.keys = null;
      api.pulled = null;
      rejectPendingReview();
    }
  });
});

// An automatic push whose composed state matches the base contacts no server, yet it ended on
// "Synced": any later store edit (a machine-local field, the sync settings themselves) turned an
// earlier failed pull or refused keyring read green while nothing had reached the server.
describe("an automatic push with nothing to send", () => {
  it("keeps an earlier sync error", async () => {
    try {
      await seedBase();
      useApp.getState().setSyncRuntime({ syncStatus: "error", syncError: "Sync failed." });
      const pushesBefore = api.pushes;
      await pushNow();
      expect(api.pushes).toBe(pushesBefore);
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toBe("Sync failed.");
    } finally {
      api.keys = null;
    }
  });

  // The other push that contacts no server: the sync backend's address changed while the keyring
  // read was parked, so the PUT is withheld from the abandoned host — and must not read "Synced".
  it("keeps an earlier sync error when the address moved mid-compose", async () => {
    let release: (v: Record<string, string>) => void = () => {};
    try {
      await seedBase();
      useApp.getState().setSyncRuntime({ syncStatus: "error", syncError: "Sync failed." });
      const pushesBefore = api.pushes;
      api.park = new Promise((r) => (release = r));
      api.readCalled = false;
      const pushing = pushNow(true);
      await vi.waitFor(() => expect(api.readCalled).toBe(true));
      useApp.setState({ backends: useApp.getState().backends.map((b) => ({ ...b, serverUrl: "http://moved:9" })) });
      release({ b1: "sk-secret" });
      await pushing;
      expect(api.pushes).toBe(pushesBefore);
      expect(useApp.getState().syncStatus).toBe("error");
      expect(useApp.getState().syncError).toBe("Sync failed.");
    } finally {
      api.park = null;
      api.keys = null;
      await resetSyncState(); // drop the follow-up push scheduled for the corrected address
    }
  });
});
