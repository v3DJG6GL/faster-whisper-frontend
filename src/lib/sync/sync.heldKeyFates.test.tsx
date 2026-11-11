// Import, the restore offer and Onboarding's restore install a backend list with no security review
// in front. A removed backend's key stays in the keyring and keys resolve by id alone, so a blob
// re-adding that id at its own address gets the key sent there: the dialogs read the keyring for
// the new ids and disclose a held (or unreadable) key. The previews also read the list exactly as
// the apply installs it (no case alias of a local id).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { backendKeyFates, carriesQuickAddPin, heldKeyCandidates, readHeldKeyIds, sanitizeInboundBackends } from "./sync";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";
import { KeyFateNotices, confirmHeldKeys, heldKeyNoticeIds, heldKeyReads } from "@/components/sync/SettingsSync";
import type { SyncBlob } from "./syncTypes";

const api = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  unreadable: [] as string[],
  fail: false,
  reads: [] as string[][],
  // Set by a test to hold the read open until it resolves this.
  gate: null as Promise<void> | null,
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeyStates: async (ids: string[]) => {
    api.reads.push(ids);
    if (api.gate) await api.gate;
    if (api.fail) throw new Error("keyring locked");
    return {
      keys: Object.fromEntries(ids.filter((id) => id in api.keys).map((id) => [id, api.keys[id]])),
      unreadable: ids.filter((id) => api.unreadable.includes(id)),
    };
  },
}));

const EVIL = "http://evil.example:8000";
const local = [backend({ id: "b1", hasApiKey: true })];
// `b9` was removed here earlier; the blob re-adds it at its own address, claiming no key.
const incoming = [backend({ id: "b1", hasApiKey: true }), backend({ id: "b9", name: "work", serverUrl: EVIL })];

const notices = (held: ReadonlySet<string>) =>
  renderToStaticMarkup(
    <KeyFateNotices fates={backendKeyFates(incoming, undefined, local, DEFAULT_SETTINGS, held)} source="file" />,
  );

describe("the held key of an id the blob re-adds", () => {
  beforeEach(() => {
    api.keys = {};
    api.unreadable = [];
    api.fail = false;
    api.reads = [];
    api.gate = null;
  });

  it("is disclosed when the keyring holds one, with the new host", async () => {
    api.keys = { b9: "old-key" };
    const held = await readHeldKeyIds(incoming, undefined, local, DEFAULT_SETTINGS);
    expect([...held]).toEqual(["b9"]);
    // Only the id new to this device is read.
    expect(api.reads).toEqual([["b9"]]);
    const fates = backendKeyFates(incoming, undefined, local, DEFAULT_SETTINGS, held);
    expect(fates.moved.map((m) => [m.backend.id, m.to, m.anyKey])).toEqual([["b9", EVIL, true]]);
    expect(notices(held)).toContain("any API key this device holds for this ID would be sent to");
    expect(notices(held)).toContain("evil.example");
  });

  it("leaves `missing` for a held id that claims a key", async () => {
    api.keys = { b9: "old-key" };
    const claims = [backend({ id: "b9", hasApiKey: true, serverUrl: EVIL })];
    const held = await readHeldKeyIds(claims, undefined, local, DEFAULT_SETTINGS);
    const fates = backendKeyFates(claims, undefined, local, DEFAULT_SETTINGS, held);
    expect(fates.missing).toEqual([]);
    expect(fates.moved.map((m) => m.backend.id)).toEqual(["b9"]);
  });

  it("adds no text for a brand-new id with an empty keyring", async () => {
    const held = await readHeldKeyIds(incoming, undefined, local, DEFAULT_SETTINGS);
    expect(held.size).toBe(0);
    expect(notices(held)).toBe(notices(new Set()));
    expect(notices(held)).toBe("");
  });

  it("fails closed when the keyring cannot read the id, or the read fails", async () => {
    api.unreadable = ["b9"];
    expect([...(await readHeldKeyIds(incoming, undefined, local, DEFAULT_SETTINGS))]).toEqual(["b9"]);
    api.unreadable = [];
    api.fail = true;
    const held = await readHeldKeyIds(incoming, undefined, local, DEFAULT_SETTINGS);
    expect([...held]).toEqual(["b9"]);
    expect(notices(held)).toContain("any API key this device holds for this ID would be sent to");
  });

  it("reads nothing when the blob carries the id's key, or every id is held here", async () => {
    expect((await readHeldKeyIds(incoming, { b9: "peer-key" }, local, DEFAULT_SETTINGS)).size).toBe(0);
    expect((await readHeldKeyIds([incoming[0]], undefined, local, DEFAULT_SETTINGS)).size).toBe(0);
    expect(api.reads).toEqual([]);
  });
});

describe("a local id flagged keyless that the blob moves", () => {
  // A degraded keyring read leaves a new backend's flag false even though its key was written;
  // the apply re-derives the flag from the keyring and the key then goes to the blob's address.
  const keyless = [backend({ id: "b2", hasApiKey: false })];

  beforeEach(() => {
    api.keys = {};
    api.unreadable = [];
    api.fail = false;
    api.reads = [];
    api.gate = null;
  });

  it("is probed, and a held key gets the same notice as a re-added id", async () => {
    api.keys = { b2: "kept-key" };
    const moved = [backend({ id: "b2", name: "home", serverUrl: EVIL })];
    const held = await readHeldKeyIds(moved, undefined, keyless, DEFAULT_SETTINGS);
    expect([...held]).toEqual(["b2"]);
    const fates = backendKeyFates(moved, undefined, keyless, DEFAULT_SETTINGS, held);
    expect(fates.moved.map((m) => [m.backend.id, m.to, m.anyKey])).toEqual([["b2", EVIL, true]]);
    expect(fates.missing).toEqual([]);
  });

  it("is not probed when unmoved (address differs only in form), keyed, or carrying a key", async () => {
    const unmoved = [backend({ id: "b2", serverUrl: `${keyless[0].serverUrl}/` })];
    expect(heldKeyCandidates(unmoved, undefined, keyless, DEFAULT_SETTINGS)).toEqual([]);
    const moved = [backend({ id: "b2", serverUrl: EVIL })];
    expect(heldKeyCandidates(moved, undefined, [{ ...keyless[0], hasApiKey: true }], DEFAULT_SETTINGS)).toEqual([]);
    expect(heldKeyCandidates(moved, { b2: "peer-key" }, keyless, DEFAULT_SETTINGS)).toEqual([]);
    expect((await readHeldKeyIds(unmoved, undefined, keyless, DEFAULT_SETTINGS)).size).toBe(0);
    expect(api.reads).toEqual([]);
  });
});

describe("a confirm click that lands before the held-key read is back", () => {
  beforeEach(() => {
    api.keys = {};
    api.unreadable = [];
    api.fail = false;
    api.reads = [];
    api.gate = null;
  });

  const noticed = (h: ReadonlySet<string>) =>
    heldKeyNoticeIds(backendKeyFates(incoming, undefined, local, DEFAULT_SETTINGS, h));
  const candidates = () => heldKeyCandidates(incoming, undefined, local, DEFAULT_SETTINGS);
  const NONE: ReadonlySet<string> = new Set();

  it("applies nothing on a held key it did not show; the second click applies", async () => {
    api.keys = { b9: "old-key" };
    let open!: () => void;
    api.gate = new Promise((r) => (open = r));
    const read = heldKeyReads();
    // The dialog's mount starts the read; the click lands while it is out, with nothing shown.
    void read(candidates());
    const click = confirmHeldKeys(read, candidates(), NONE, noticed);
    open();
    const first = await click;
    expect(first.go).toBe(false);
    // The caller now shows what the read found: the notice naming the new host.
    expect(notices(first.ids)).toContain("evil.example");
    const second = await confirmHeldKeys(read, candidates(), first.ids, noticed);
    expect(second.go).toBe(true);
    // One keyring read for the list, shared by the mount and both clicks.
    expect(api.reads).toEqual([["b9"]]);
  });

  it("applies on the first click when nothing is held", async () => {
    let open!: () => void;
    api.gate = new Promise((r) => (open = r));
    const read = heldKeyReads();
    const click = confirmHeldKeys(read, candidates(), NONE, noticed);
    open();
    expect((await click).go).toBe(true);
  });

  it("fails closed on a failed read: notice first, then the second click applies", async () => {
    api.fail = true;
    const read = heldKeyReads();
    const first = await confirmHeldKeys(read, candidates(), NONE, noticed);
    expect(first.go).toBe(false);
    expect(notices(first.ids)).toContain("any API key this device holds for this ID would be sent to");
    expect((await confirmHeldKeys(read, candidates(), first.ids, noticed)).go).toBe(true);
  });

  it("never decides on a result read for another list", async () => {
    api.keys = { b9: "old-key" };
    const read = heldKeyReads();
    // A read for an older selection without b9 came back empty …
    expect((await read([])).size).toBe(0);
    // … and the click for the current list still reads b9 and stops.
    expect((await confirmHeldKeys(read, candidates(), NONE, noticed)).go).toBe(false);
  });
});

describe("previews read the list the apply installs", () => {
  it("drop a case alias of a local id", () => {
    const list = [backend({ id: "B1", serverUrl: EVIL }), backend({ id: "b2" })];
    expect(sanitizeInboundBackends(list, local).map((b) => b.id)).toEqual(["b2"]);
    // The apply drops the alias, and the dangling-reference scrub then nulls its pin.
    const blob = { dictionary: { quickAddList: { backendId: "B1", slug: "words" } }, backends: { list } } as SyncBlob;
    expect(carriesQuickAddPin(blob, local)).toBe(false);
    expect(carriesQuickAddPin(blob, [])).toBe(true);
  });
});
