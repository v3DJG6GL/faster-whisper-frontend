// pushNow's 409 auto-merge used to merge and apply the blob it composed BEFORE the PUT, so a
// setting edited while the request was on the wire was in neither that blob nor the merge: the
// apply hydrated over it, the retry pushed the old value and adopted it as the base, and the
// edit's own push then found nothing to send. The merge must start from the live store.

import { expect, it, vi } from "vitest";
import { pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";
import type { SyncBlob } from "./syncTypes";

/** pushNow runs only "in Tauri". `onPush` runs once, inside the next PUT (the user editing while
 *  it is on the wire); `conflicts` answers PUTs (once each, in order) with a 409. */
const api = vi.hoisted(() => ({
  pushes: 0,
  pushed: null as unknown,
  conflicts: [] as unknown[],
  onPush: null as null | (() => void),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async () => ({ b1: "sk" }),
  readBackendKeyStates: async () => ({ keys: { b1: "sk" }, unreadable: [] }),
  setBackendKey: async () => {},
  deleteBackendKey: async () => {},
  syncPush: async (args: { blob: unknown; baseVersion: number }) => {
    api.pushes++;
    api.pushed = args.blob;
    const hook = api.onPush;
    api.onPush = null;
    hook?.();
    const conflict = api.conflicts.shift();
    if (conflict) return { ok: false, status: 409, conflict };
    const v = args.baseVersion + 1;
    return { ok: true, status: 200, state: { version: v, updated_ts: v, device: "me", blob: {} } };
  },
}));

it("a setting edited while a push is on the wire survives the 409 auto-merge", async () => {
  await resetSyncState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
  useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
  await pushNow(true); // the v1 base
  const base = structuredClone(api.pushed) as SyncBlob;
  // A different category from the peer's, so the two auto-merge instead of conflicting.
  const edited = useApp.getState().settings.recording.chipScale === 1.5 ? 1.25 : 1.5;
  const peerStart = !useApp.getState().settings.general.startMinimized;
  const remote = structuredClone(base);
  remote.general = { ...remote.general, startMinimized: peerStart } as never;
  api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: remote }];
  api.onPush = () => {
    const s = useApp.getState().settings;
    useApp.setState({ settings: { ...s, recording: { ...s.recording, chipScale: edited } } });
  };
  await pushNow(true);
  const s = useApp.getState();
  expect(s.syncStatus).toBe("ok");
  expect(s.settings.recording.chipScale).toBe(edited);
  expect(s.settings.general.startMinimized).toBe(peerStart); // the peer's change still merged in
  expect((api.pushed as SyncBlob).chip?.chipScale).toBe(edited);
});
