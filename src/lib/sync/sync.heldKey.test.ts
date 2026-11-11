// A removed backend's API key stays in the keyring, and keys are looked up by backend id alone.
// A peer that re-adds that id at its own address would get the old key sent there behind a row
// that reads only "New server added", so the review discloses the held key (fail closed when the
// keyring cannot say). Approving still applies the update as before.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvePendingReview, getPendingReview, pullNow, pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { DEFAULT_SETTING_SYNC } from "../settingsManifest";
import { backend } from "./syncTestFixtures";
import type { SyncBlob } from "./syncTypes";

const api = vi.hoisted(() => ({
  pushed: null as unknown,
  pull: null as unknown,
  keys: {} as Record<string, string>,
  unreadable: [] as string[],
  reads: [] as string[][],
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async (ids: string[]) => Object.fromEntries(ids.filter((id) => id in api.keys).map((id) => [id, api.keys[id]])),
  readBackendKeyStates: async (ids: string[]) => {
    api.reads.push(ids);
    return {
      keys: Object.fromEntries(ids.filter((id) => id in api.keys).map((id) => [id, api.keys[id]])),
      unreadable: ids.filter((id) => api.unreadable.includes(id)),
    };
  },
  setBackendKey: async () => {},
  deleteBackendKey: async () => {},
  syncPush: async (args: { blob: unknown; baseVersion: number }) => {
    api.pushed = args.blob;
    const v = args.baseVersion + 1;
    return { ok: true, status: 200, state: { version: v, updated_ts: v, device: "me", blob: {} } };
  },
  syncPull: async () => ({ ok: true, status: 200, state: api.pull }),
}));

const EVIL = "http://evil.example:8000";
const HELD = "any API key this device holds for this server ID would be sent to it";

/** A synced base holding only b1; the peer then re-adds `b9` (removed here earlier) at `EVIL`. */
async function seed(apiKeys: boolean, secret?: string): Promise<void> {
  await resetSyncState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = {
    ...settings.sync!,
    enabled: true,
    backendId: "b1",
    sub: { ...DEFAULT_SETTING_SYNC, recordingsDir: false, serverAddresses: true, apiKeys },
  };
  useApp.setState({ settings, backends: [backend()], profiles: [], appRules: [], status: "idle" });
  await pushNow(true);
  const remote = structuredClone(api.pushed) as SyncBlob;
  remote.backends = {
    ...remote.backends!,
    list: [...remote.backends!.list, backend({ id: "b9", name: "work", serverUrl: EVIL })],
    ...(secret ? { secrets: { b9: secret } } : {}),
  };
  api.pull = { version: 5, updated_ts: 5, device: "peer", blob: remote };
}

const rows = () => getPendingReview()?.changes.map((c) => [c.kind, c.id, c.kind === "api-key" ? c.detail : ""]);

describe("a peer re-adding a backend id whose key this device still holds", () => {
  beforeEach(() => {
    api.keys = {};
    api.unreadable = [];
    api.reads = [];
  });

  it("discloses the held key, and approving still installs the backend", async () => {
    await seed(true);
    api.keys = { b9: "old-key" };
    await pullNow(true);
    expect(rows()).toEqual([
      ["new-backend", "b9", ""],
      ["api-key", "b9", HELD],
    ]);
    await approvePendingReview();
    expect(getPendingReview()).toBeNull();
    expect(useApp.getState().backends.map((b) => [b.id, b.serverUrl])).toEqual([
      ["b1", "http://10.0.0.2:8000"],
      ["b9", EVIL],
    ]);
  });

  it("adds nothing when the keyring holds no key for the id", async () => {
    await seed(true);
    await pullNow(true);
    expect(rows()).toEqual([["new-backend", "b9", ""]]);
    // Only the new id is read.
    expect(api.reads.some((ids) => ids.length === 1 && ids[0] === "b9")).toBe(true);
  });

  it("adds nothing when an inbound key replaces it, but discloses with 'API keys' off", async () => {
    await seed(true, "peer-key");
    api.keys = { b9: "old-key" };
    await pullNow(true);
    expect(rows()?.filter((r) => r[0] === "api-key" && r[2] === HELD)).toEqual([]);

    await seed(false, "peer-key");
    api.keys = { b9: "old-key" };
    await pullNow(true);
    expect(rows()).toEqual([
      ["new-backend", "b9", ""],
      ["api-key", "b9", HELD],
    ]);
  });

  it("reads no keyring entry when this device does not sync backends", async () => {
    await seed(true);
    const settings = structuredClone(useApp.getState().settings);
    settings.sync = { ...settings.sync!, sub: { ...settings.sync!.sub!, backendList: false } };
    useApp.setState({ settings });
    api.keys = { b9: "old-key" };
    api.reads = [];
    await pullNow(true);
    expect(api.reads).toEqual([]);
    expect(useApp.getState().backends.map((b) => b.id)).toEqual(["b1"]);
  });

  it("reads no keyring entry for an id whose inbound key replaces it", async () => {
    await seed(true, "peer-key");
    api.reads = [];
    await pullNow(true);
    expect(api.reads.some((ids) => ids.includes("b9"))).toBe(false);
  });

  it("fails closed when the keyring cannot read the id", async () => {
    await seed(true);
    api.unreadable = ["b9"];
    await pullNow(true);
    expect(rows()).toEqual([
      ["new-backend", "b9", ""],
      ["api-key", "b9", HELD],
    ]);
  });
});
