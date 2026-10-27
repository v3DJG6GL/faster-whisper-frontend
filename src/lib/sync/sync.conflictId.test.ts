import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  getPendingConflict,
  getPendingReview,
  raiseConflictForTests,
  resolveSyncConflicts,
  setSyncBaseForTests,
} from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { DEFAULT_SETTING_SYNC } from "../settingsManifest";
import { backend } from "./syncTestFixtures";
import type { SyncState } from "./syncTypes";

/** Record what the engine writes to sync-state.json (outside Tauri the real call no-ops). */
const saved = vi.hoisted(() => ({ last: null as null | SyncState }));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return {
    ...orig,
    saveSyncState: async (st: SyncState) => {
      saved.last = st;
    },
  };
});

function reset() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, sub: { ...DEFAULT_SETTING_SYNC, recordingsDir: DEFAULT_SETTING_SYNC.audioFolder } };
  useApp.setState({ settings, backends: [backend()], profiles: [], appRules: [], status: "idle" });
}

/** Turn the "Server addresses" sync gate on or off in the live store. */
function setServerAddresses(on: boolean): void {
  const settings = structuredClone(useApp.getState().settings);
  settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
  useApp.setState({ settings });
}

// The conflict dialog tags its picks with the id and the remote key: a new remote must get a
// NEW remote key so the picks start empty — a retained "remote" pick from the previous conflict
// would silently hand the peer content the user never chose. A re-raise of the same remote over a
// changed category list keeps the key, and the dialog keeps the picks for the categories shown.
describe("pending-conflict identity", () => {
  it("each raised conflict gets a distinct id", () => {
    raiseConflictForTests();
    const first = getPendingConflict();
    raiseConflictForTests({ remoteVersion: 99 });
    const second = getPendingConflict();
    expect(first?.id).toBeTypeOf("number");
    expect(second?.id).not.toBe(first?.id);
  });

  it("re-raising the same conflict keeps its id", () => {
    // Every focus pull re-raises a pending conflict (it adopts no base); a fresh id each time
    // remounted the dialog and reset the user's half-made picks on every window switch.
    raiseConflictForTests({ remoteVersion: 7, remoteDevice: "laptop-b" });
    const first = getPendingConflict();
    raiseConflictForTests({ remoteVersion: 7, remoteDevice: "laptop-b" });
    expect(getPendingConflict()?.id).toBe(first?.id);
    // A different category set is a different conflict.
    raiseConflictForTests({ remoteVersion: 7, remoteDevice: "laptop-b", categories: ["general", "chip"] });
    expect(getPendingConflict()?.id).not.toBe(first?.id);
  });

  it("a re-raise of the same remote over other categories keeps the remote key", () => {
    // resolveLocked's widening re-raise keeps the remote version, stamp and writer. A new remote
    // key there reset the dialog's picks, so a "remote" pick came back on "This device" and the
    // next Apply silently kept this device's settings.
    raiseConflictForTests({ remoteVersion: 9, remoteUpdatedAt: 1700000000, remoteDevice: "laptop-b" });
    const first = getPendingConflict()!;
    raiseConflictForTests({
      remoteVersion: 9,
      remoteUpdatedAt: 1700000000,
      remoteDevice: "laptop-b",
      categories: ["general", "chip"],
    });
    const widened = getPendingConflict()!;
    expect(widened.id).not.toBe(first.id);
    expect(widened.remoteKey).toBe(first.remoteKey);
    // Another remote version, stamp or writer is another remote: the picks start empty.
    raiseConflictForTests({
      remoteVersion: 10,
      remoteUpdatedAt: 1700000000,
      remoteDevice: "laptop-b",
      categories: ["general", "chip"],
    });
    const newer = getPendingConflict()!;
    expect(newer.remoteKey).not.toBe(widened.remoteKey);
    raiseConflictForTests({
      remoteVersion: 10,
      remoteUpdatedAt: 1700000000,
      remoteDevice: "laptop-c",
      categories: ["general", "chip"],
    });
    const otherWriter = getPendingConflict()!;
    expect(otherWriter.remoteKey).not.toBe(newer.remoteKey);
    raiseConflictForTests({
      remoteVersion: 10,
      remoteUpdatedAt: 1700009999,
      remoteDevice: "laptop-c",
      categories: ["general", "chip"],
    });
    expect(getPendingConflict()!.remoteKey).not.toBe(otherWriter.remoteKey);
  });

  it("picks made on one conflict never resolve another", async () => {
    // A resolve that re-merged into more categories re-raises the conflict with a new id. The
    // dialog's next Apply carried picks for the categories it had shown only, and the unseen one
    // fell to this device's value without the user ever choosing.
    reset();
    await setSyncBaseForTests("none");
    raiseConflictForTests({ remoteVersion: 8, categories: ["general"] });
    const shown = getPendingConflict()!.id;
    raiseConflictForTests({ remoteVersion: 8, categories: ["general", "chip"] });
    const widened = getPendingConflict()!.id;
    await resolveSyncConflicts({ general: "remote" }, shown);
    expect(getPendingConflict()?.id).toBe(widened);
    expect(getPendingConflict()?.categories).toEqual(["general", "chip"]);
  });
});

describe("resolveSyncConflicts", () => {
  // No base (first contact) unless a test sets one: the resolve re-merges against it, so a base
  // leaked from an earlier test's adoption would decide which categories conflict.
  beforeEach(async () => {
    reset();
    await setSyncBaseForTests("none");
  });

  it("the local side of the security review knows this device's backends", async () => {
    // `c.local` is a COMPOSED blob: a degraded keyring read re-sends the snapshot's `backends`,
    // missing when the snapshot holds none. Read as "this device has no backends", every server
    // backend — including ones held here byte-identically — was a "new backend" and parked sync
    // on a review dialog.
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
    // Every adopt site records the writer of the version being adopted; this one
    // kept naming the PREVIOUS sync's device under "Last synced just now · from X".
    useApp.getState().setSyncRuntime({ lastSyncDevice: "laptop-a" });
    raiseConflictForTests({ remoteDevice: "laptop-b" });
    await resolveSyncConflicts({ general: "remote" });
    expect(useApp.getState().lastSyncDevice).toBe("laptop-b");
  });

  it("adopting a resolution persists the server's timestamp for the adopted version", async () => {
    // initSync restores "Last synced" only from a truthy `updatedAt`; a null one read as "Not
    // synced yet." after every restart, and an all-remote resolution never pushes to re-stamp it.
    saved.last = null;
    raiseConflictForTests({ remoteVersion: 4, remoteUpdatedAt: 1700000000, remoteDevice: "laptop-b" });
    await resolveSyncConflicts({ general: "remote" });
    const last = saved.last as SyncState | null; // written by the mock, not visible to narrowing
    expect(last?.version).toBe(4);
    expect(last?.updatedAt).toBe(1700000000);
  });

  it("approving a review after 'Server addresses' was turned on re-raises it with the repoint", async () => {
    // Raised with the gate off, the review lists only the new backend (the apply would re-pin
    // b1's address). Turning the gate on does not supersede the review, and applyBlob reads the
    // gates live — so approving as shown would repoint b1 without the user ever seeing it.
    setServerAddresses(false);
    raiseConflictForTests({
      categories: ["backends"],
      local: {},
      remote: { backends: { list: [backend({ serverUrl: "http://evil:9" }), backend({ id: "b2", serverUrl: "http://peer:9" })] } },
      merged: {},
    });
    await resolveSyncConflicts({ backends: "remote" });
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["new-backend"]);
    setServerAddresses(true);
    await approvePendingReview();
    expect(getPendingReview()?.changes.map((c) => c.kind).sort()).toEqual(["new-backend", "server-url"]);
    // The dialog has to say WHY the list grew, or a second click consents to rows nobody read.
    expect(getPendingReview()?.relisted).toBe(true);
    expect(useApp.getState().backends.find((b) => b.id === "b1")?.serverUrl).toBe("http://10.0.0.2:8000");
    // Approving the list as now shown applies it.
    await approvePendingReview();
    expect(getPendingReview()).toBeNull();
    expect(useApp.getState().backends.find((b) => b.id === "b1")?.serverUrl).toBe("http://evil:9");
  });

  it("the re-judge compares against this device as it is now, not the raise-time compose", async () => {
    // Every raiser composes `local` under the raise-time gates, and with "Server addresses" off
    // composeBlob substitutes the snapshot's (the peer's) address for b1's live one. Re-judging
    // against that stale compose saw no repoint, so approving landed it with no consent row.
    setServerAddresses(false);
    const incoming = { backends: { list: [backend({ serverUrl: "http://evil:9" }), backend({ id: "b2", serverUrl: "http://peer:9" })] } };
    raiseConflictForTests({
      categories: ["backends"],
      local: { backends: { list: [backend({ serverUrl: "http://evil:9" })] } },
      remote: incoming,
      merged: incoming,
    });
    await resolveSyncConflicts({ backends: "remote" });
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["new-backend"]);
    setServerAddresses(true);
    await approvePendingReview();
    expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("server-url");
    expect(useApp.getState().backends.find((b) => b.id === "b1")?.serverUrl).toBe("http://10.0.0.2:8000");
  });

  it("resolving after 'Server addresses' was turned on judges against this device as it is now", async () => {
    // The conflict's `local` was composed with the gate off (the peer's address substituted for
    // b1's). Turning the gate on does not supersede the conflict, and applyBlob reads it live —
    // judged against the stale compose, the merged repoint compared equal and landed unreviewed.
    const evil = { backends: { list: [backend({ serverUrl: "http://evil:9" })] } };
    // The last sync agreed on b1's own address, so the repoint is the peer's alone: the re-merge
    // takes it without a conflict and only the security gate stands between it and the apply.
    await setSyncBaseForTests("live");
    setServerAddresses(false);
    raiseConflictForTests({ categories: ["general"], local: evil, remote: evil, merged: evil });
    setServerAddresses(true);
    await resolveSyncConflicts({ general: "remote" });
    expect(getPendingReview()?.changes.map((c) => c.kind)).toContain("server-url");
    expect(useApp.getState().backends.find((b) => b.id === "b1")?.serverUrl).toBe("http://10.0.0.2:8000");
  });

  it("a 'keep mine' pick keeps this device's live value, not the raise-time compose", async () => {
    const evil = { backends: { list: [backend({ serverUrl: "http://evil:9" })] } };
    setServerAddresses(false);
    raiseConflictForTests({ categories: ["backends"], local: evil, remote: evil, merged: evil });
    setServerAddresses(true);
    await resolveSyncConflicts({ backends: "local" });
    expect(useApp.getState().backends.find((b) => b.id === "b1")?.serverUrl).toBe("http://10.0.0.2:8000");
  });
});
