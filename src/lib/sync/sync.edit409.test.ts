// pushNow's 409 auto-merge must start from the live store, not the blob composed before the PUT:
// a setting edited while the request is on the wire is in neither, so the apply would revert it,
// the retry push and adopt the old value as base, and the edit's own push find nothing to send.

import { expect, it, vi } from "vitest";
import {
  approvePendingReview,
  getPendingConflict,
  getPendingReview,
  hasPendingApplyForTests,
  pullNow,
  pushNow,
  resetSyncState,
} from "./sync";
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
  // A different category from the peer's, so the two auto-merge instead of conflicting.
  const { edited, peerStart, remote } = await seed();
  api.conflicts = [{ version: 5, updated_ts: 5, device: "peer", blob: remote }];
  api.onPush = () => editChipScale(edited);
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
// compose's is in neither the compose nor the merge, and the apply would revert it.
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
// meanwhile, so an edit made in THAT wait is in the live compose and in no "edited" test: the
// conflicting category would count as untouched, and the reviewed value go back over the edit.
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

// A review's held-back apply that an edit dropped (made during the apply's keyring wait) landed
// nothing, so the store it signs must be the one the merge was composed from: signed after the
// drop, the edit is in the signature, the approval counts the category as unedited and puts the
// reviewed (pre-edit) value back over it.
it("a setting edited while a review's apply waits on the keyring survives the approval", async () => {
  const { edited, remote } = await seed();
  // The peer changes another chip field (no conflict with the store yet) and lowers the
  // retention (held for review), so the raise applies everything else, backends included.
  remote.chip = { ...remote.chip, dotScale: 2 } as never;
  remote.recording = { ...remote.recording, dictationRetentionDays: 1 } as never;
  api.pull = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  // The first keyring read is the compose's; the edit lands in the apply's.
  api.onKeyRead = () => {
    api.onKeyRead = () => editChipScale(edited);
  };
  await pullNow(true);
  expect(getPendingReview()).not.toBeNull();
  expect(useApp.getState().settings.recording.dotScale).not.toBe(2); // the apply dropped
  await approvePendingReview();
  expect(useApp.getState().settings.recording.chipScale).toBe(edited);
  expect(getPendingConflict()?.categories).toContain("chip");
});

// An edit's debounced push that fires while another sync holds the lock (a slow PUT, a wallet
// prompt) must retry: the lock holder's 200 adopts the blob it composed BEFORE the edit, and
// nothing else re-sends the edit until an unrelated trigger.
it("an automatic push that fires while a push is on the wire retries after it", async () => {
  const { edited } = await seed();
  api.onPush = () => {
    editChipScale(edited);
    void pushNow(); // the edit's debounced push, hitting the in-flight push's lock
  };
  vi.useFakeTimers();
  try {
    const pushesBefore = api.pushes;
    await pushNow(true);
    expect(api.pushes).toBe(pushesBefore + 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.pushes).toBe(pushesBefore + 2);
  } finally {
    vi.useRealTimers();
  }
  expect((api.pushed as SyncBlob).chip?.chipScale).toBe(edited);
});

// The Sync tab shows `syncError` only while `syncUnsupported` is clear: a flag cleared by nothing
// but a pull's or a push's 200 would leave a push's conflict notice, after an old server's 404
// and a backend update, hidden behind "doesn't support settings sync".
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

// The same for every other answer: after a backend update a wrong key's 401 (or a 5xx) would stay
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

// A pull's merge dropped because the user edited during its apply's keyring wait (up to 10 s
// apiece behind a wallet prompt) adopts no base and pushes nothing: the drop re-arms a push, so
// the edit and the peer's change still sync (the 409, then the merge on the peer's base).
it("a pull merge dropped by an edit during the apply's keyring wait re-arms the edit's push", async () => {
  const { edited, peerStart, remote } = await seed();
  const peer = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  api.pull = peer;
  api.conflicts = [peer];
  // The first keyring read is the compose's; the edit lands in the apply's.
  api.onKeyRead = () => {
    api.onKeyRead = () => editChipScale(edited);
  };
  vi.useFakeTimers();
  try {
    const pushesBefore = api.pushes;
    await pullNow(true);
    expect(useApp.getState().settings.general.startMinimized).not.toBe(peerStart); // dropped
    expect(api.pushes).toBe(pushesBefore);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.pushes).toBe(pushesBefore + 2); // the 409, then the merge on the peer's base
  } finally {
    vi.useRealTimers();
  }
  const s = useApp.getState();
  expect(s.syncStatus).toBe("ok");
  expect(s.settings.recording.chipScale).toBe(edited);
  expect(s.settings.general.startMinimized).toBe(peerStart);
  expect((api.pushed as SyncBlob).chip?.chipScale).toBe(edited);
});

// The same drop with a dictation started during the wait as well: the caller re-arms the push only
// at idle, and the session's end moves no slice, so unless the apply parks a re-pull for that end
// neither the edit nor the peer's change syncs until the next window focus.
it("a pull merge dropped by an edit and a dictation during the apply's keyring wait parks a re-pull", async () => {
  const { edited, peerStart, remote } = await seed();
  const peer = { version: 5, updated_ts: 5, device: "peer", blob: remote };
  api.pull = peer;
  api.conflicts = [peer];
  api.onKeyRead = () => {
    api.onKeyRead = () => {
      editChipScale(edited);
      useApp.setState({ status: "recording" as never });
    };
  };
  vi.useFakeTimers();
  try {
    const pushesBefore = api.pushes;
    await pullNow(true);
    expect(useApp.getState().settings.general.startMinimized).not.toBe(peerStart); // dropped
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.pushes).toBe(pushesBefore); // no push re-armed under the session
    expect(hasPendingApplyForTests()).toBe(true); // the session's end re-pulls instead
  } finally {
    vi.useRealTimers();
    useApp.setState({ status: "idle" });
    await resetSyncState();
  }
});
