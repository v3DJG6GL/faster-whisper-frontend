// pushNow's 409 auto-merge used to merge and apply the blob it composed BEFORE the PUT, so a
// setting edited while the request was on the wire was in neither that blob nor the merge: the
// apply hydrated over it, the retry pushed the old value and adopted it as the base, and the
// edit's own push then found nothing to send. The merge must start from the live store.

import { expect, it, vi } from "vitest";
import { approvePendingReview, getPendingConflict, getPendingReview, pullNow, pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";
import type { SyncBlob } from "./syncTypes";

/** pushNow runs only "in Tauri". `onPush` runs once, inside the next PUT (the user editing while
 *  it is on the wire); `onKeyRead` once, inside the next keyring read (the user editing while a
 *  compose waits on the wallet); `fail` answers the next PUT with that status; `conflicts` answers
 *  PUTs (once each, in order) with a 409; `pull` answers the next GET. */
const api = vi.hoisted(() => ({
  pushes: 0,
  pushed: null as unknown,
  fail: null as null | number,
  conflicts: [] as unknown[],
  onPush: null as null | (() => void),
  onKeyRead: null as null | (() => void),
  pull: null as unknown,
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async () => ({ b1: "sk" }),
  readBackendKeyStates: async () => {
    const hook = api.onKeyRead;
    api.onKeyRead = null;
    hook?.();
    return { keys: { b1: "sk" }, unreadable: [] };
  },
  setBackendKey: async () => {},
  deleteBackendKey: async () => {},
  syncPush: async (args: { blob: unknown; baseVersion: number }) => {
    api.pushes++;
    api.pushed = args.blob;
    const hook = api.onPush;
    api.onPush = null;
    hook?.();
    const fail = api.fail;
    api.fail = null;
    if (fail !== null) return { ok: false, status: fail, error: `HTTP ${fail}` };
    const conflict = api.conflicts.shift();
    if (conflict) return { ok: false, status: 409, conflict };
    const v = args.baseVersion + 1;
    return { ok: true, status: 200, state: { version: v, updated_ts: v, device: "me", blob: {} } };
  },
  syncPull: async () => ({ ok: true, status: 200, state: api.pull }),
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

/** A v1 base with chipScale synced, plus a peer's change to another category on top of it and the
 *  value the user's edit sets. */
async function seed(): Promise<{ edited: number; peerStart: boolean; remote: SyncBlob }> {
  await resetSyncState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
  useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
  await pushNow(true);
  const remote = structuredClone(api.pushed) as SyncBlob;
  const peerStart = !useApp.getState().settings.general.startMinimized;
  remote.general = { ...remote.general, startMinimized: peerStart } as never;
  const edited = useApp.getState().settings.recording.chipScale === 1.5 ? 1.25 : 1.5;
  return { edited, peerStart, remote };
}

function editChipScale(value: number): void {
  const s = useApp.getState().settings;
  useApp.setState({ settings: { ...s, recording: { ...s.recording, chipScale: value } } });
}

// The recompose reads the store and THEN waits on the keyring (up to 10 s behind a wallet
// prompt); applyBlob's stale guard only covers its own wait, so an edit made during the
// compose's was in neither the compose nor the merge, and the apply reverted it.
it("a setting edited while the 409 recompose waits on the keyring survives the auto-merge", async () => {
  const { edited, peerStart, remote } = await seed();
  api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: remote }];
  // Armed inside the PUT, so the edit lands in the recompose's keyring read.
  api.onPush = () => {
    api.onKeyRead = () => editChipScale(edited);
  };
  await pushNow(true);
  const s = useApp.getState();
  expect(s.syncStatus).toBe("ok");
  expect(s.settings.recording.chipScale).toBe(edited);
  expect(s.settings.general.startMinimized).toBe(peerStart);
  expect((api.pushed as SyncBlob).chip?.chipScale).toBe(edited);
});

it("a setting edited while a pull's compose waits on the keyring survives the merge", async () => {
  const { edited, peerStart, remote } = await seed();
  api.pull = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  api.onKeyRead = () => editChipScale(edited);
  await pullNow(true);
  const s = useApp.getState();
  expect(s.settings.recording.chipScale).toBe(edited);
  expect(s.settings.general.startMinimized).toBe(peerStart);
});

// The approval decides "edited since the raise" from the store as it moved during the signature's
// keyring wait. Its compose then waits on the keyring too, and recomposes when the store moved
// meanwhile, so an edit made in THAT wait was in the live compose and in no "edited" test: the
// conflicting category counted as untouched, and the reviewed value went back over the edit.
it("a setting edited while an approval's compose waits on the keyring survives the approval", async () => {
  const { edited, remote } = await seed();
  // The peer changes the chip (applied at the raise) and lowers the retention (held for review).
  const peerScale = edited === 1.5 ? 1.75 : 2;
  remote.chip = { ...remote.chip, chipScale: peerScale } as never;
  remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
  api.pull = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  await pullNow(true);
  expect(getPendingReview()).not.toBeNull();
  expect(useApp.getState().settings.recording.chipScale).toBe(peerScale);
  // The first keyring read is the store signature's; the edit lands in the compose's.
  api.onKeyRead = () => {
    api.onKeyRead = () => editChipScale(edited);
  };
  const pushesBefore = api.pushes;
  await approvePendingReview();
  expect(getPendingReview()).toBeNull();
  const s = useApp.getState();
  expect(s.settings.recording.chipScale).toBe(edited);
  expect(s.settings.transcribe?.dictationRetentionDays).toBe(1);
  // The follow-up push carries the edit on the adopted base, not the peer's value.
  await vi.waitFor(() => expect(api.pushes).toBe(pushesBefore + 1));
  expect((api.pushed as SyncBlob).chip?.chipScale).toBe(edited);
});

// The Sync tab shows `syncError` only while `syncUnsupported` is clear, and only a pull's or a
// push's 200 cleared it: after an old server's 404 and a backend update, a push's conflict
// notice stayed hidden behind "doesn't support settings sync".
it("a push conflict clears an earlier 404's unsupported-server flag", async () => {
  const { edited, remote } = await seed();
  api.fail = 404;
  await pushNow(true);
  expect(useApp.getState().syncUnsupported).toBe(true);
  // Both sides change the chip: a conflict, not an auto-merge (whose retried 200 clears it too).
  editChipScale(edited);
  remote.chip = { ...remote.chip, chipScale: edited === 1.5 ? 1.75 : 2 } as never;
  api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: remote }];
  await pushNow(true);
  expect(getPendingConflict()).not.toBeNull();
  const s = useApp.getState();
  expect(s.syncUnsupported).toBe(false);
  expect(s.syncError).toMatch(/resolve the conflict/);
});

// The same for every other answer: after a backend update a wrong key's 401 (or a 5xx) stayed
// hidden behind "update faster-whisper-backend". No answer at all (status 0) says nothing.
it("an answered push failure after a 404 clears the unsupported-server flag, an unreachable one keeps it", async () => {
  const { edited } = await seed();
  editChipScale(edited);
  api.fail = 404;
  await pushNow(true);
  expect(useApp.getState().syncUnsupported).toBe(true);
  api.fail = 0;
  await pushNow(true);
  expect(useApp.getState().syncUnsupported).toBe(true);
  api.fail = 401;
  await pushNow(true);
  let s = useApp.getState();
  expect(s.syncUnsupported).toBe(false);
  expect(s.syncError).toBe("The server rejected the API key.");
  api.fail = 404;
  await pushNow(true);
  api.fail = 502;
  await pushNow(true);
  s = useApp.getState();
  expect(s.syncUnsupported).toBe(false);
  expect(s.syncError).toBe("HTTP 502");
});
