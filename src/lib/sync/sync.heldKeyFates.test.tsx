// Import, the restore offer and Onboarding's restore install a backend list with no security review
// in front. A removed backend's key stays in the keyring and keys resolve by id alone, so a blob
// re-adding that id at its own address gets the key sent there: the dialogs read the keyring for
// the new ids and disclose a held (or unreadable) key. The previews also read the list exactly as
// the apply installs it (no case alias of a local id).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { backendKeyFates, carriesQuickAddPin, readHeldKeyIds, sanitizeInboundBackends } from "./sync";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";
import { KeyFateNotices } from "@/components/sync/SettingsSync";
import type { SyncBlob } from "./syncTypes";

const api = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  unreadable: [] as string[],
  fail: false,
  reads: [] as string[][],
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeyStates: async (ids: string[]) => {
    api.reads.push(ids);
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
  });

  it("is disclosed when the keyring holds one, with the new host", async () => {
    api.keys = { b9: "old-key" };
    const held = await readHeldKeyIds(incoming, undefined, local);
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
    const held = await readHeldKeyIds(claims, undefined, local);
    const fates = backendKeyFates(claims, undefined, local, DEFAULT_SETTINGS, held);
    expect(fates.missing).toEqual([]);
    expect(fates.moved.map((m) => m.backend.id)).toEqual(["b9"]);
  });

  it("adds no text for a brand-new id with an empty keyring", async () => {
    const held = await readHeldKeyIds(incoming, undefined, local);
    expect(held.size).toBe(0);
    expect(notices(held)).toBe(notices(new Set()));
    expect(notices(held)).toBe("");
  });

  it("fails closed when the keyring cannot read the id, or the read fails", async () => {
    api.unreadable = ["b9"];
    expect([...(await readHeldKeyIds(incoming, undefined, local))]).toEqual(["b9"]);
    api.unreadable = [];
    api.fail = true;
    const held = await readHeldKeyIds(incoming, undefined, local);
    expect([...held]).toEqual(["b9"]);
    expect(notices(held)).toContain("any API key this device holds for this ID would be sent to");
  });

  it("reads nothing when the blob carries the id's key, or every id is held here", async () => {
    expect((await readHeldKeyIds(incoming, { b9: "peer-key" }, local)).size).toBe(0);
    expect((await readHeldKeyIds([incoming[0]], undefined, local)).size).toBe(0);
    expect(api.reads).toEqual([]);
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
