import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingReview,
  getPendingConflict,
  getPendingReview,
  raiseConflictForTests,
  resolveSyncConflicts,
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
    const setServerAddresses = (on: boolean) => {
      const settings = structuredClone(useApp.getState().settings);
      settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
      useApp.setState({ settings });
    };
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
    const setServerAddresses = (on: boolean) => {
      const settings = structuredClone(useApp.getState().settings);
      settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, serverAddresses: on } };
      useApp.setState({ settings });
    };
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
});
