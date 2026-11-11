// A backend id that differs from a local one only in letter case: Windows Credential Manager
// matches target names case-insensitively, so such an alias can resolve this device's stored key
// for the real backend. Real ids are lower-case UUIDs, so an inbound alias is dropped — neither
// installed, listed for review, nor given a key — and references to it fall back as to any
// backend the list lacks.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBlob, categorySelection, resetSyncState, sanitizeBackends, sanitizeProfiles, securityChanges } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";
import type { Profile } from "../types";
import type { SyncBlob } from "./syncTypes";

const api = vi.hoisted(() => ({ written: [] as string[] }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async () => ({ b1: "sk" }),
  readBackendKeyStates: async () => ({ keys: { b1: "sk" }, unreadable: [] }),
  setBackendKey: async (id: string) => {
    api.written.push(id);
  },
  deleteBackendKey: async () => {},
}));

const CATS = categorySelection(true);
const ALIAS = "B1";
const profile = (over: Partial<Profile> = {}): Profile =>
  ({ id: "p1", name: "P", activation: "hold", enabled: true, hotkey: ["F9"], backendId: "b1", ...over }) as Profile;

describe("a backend id that is a case alias of a local one", () => {
  beforeEach(async () => {
    await resetSyncState();
    api.written = [];
    useApp.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      backends: [backend({ hasApiKey: true })],
      profiles: [profile()],
      appRules: [],
      status: "idle",
    });
  });

  it("sanitizeBackends keeps the first of two ids differing only in case", () => {
    const list = sanitizeBackends([backend({ id: "abc" }), backend({ id: "ABC", serverUrl: "http://evil.example" })]);
    expect(list.map((b) => b.id)).toEqual(["abc"]);
  });

  it("sanitizeBackends caps at 500 distinct ids, counted after the dedupe, and fills only those", () => {
    // Duplicates (exact and case-only) ahead of the cap must not use up its slots.
    const raw: unknown[] = [];
    for (let i = 0; i < 700; i++) raw.push({ id: `b${i}`, serverUrl: "" }, { id: `B${i}`, serverUrl: "x" });
    raw.push(null, { id: 5 }, { id: "b0", serverUrl: "" });
    const list = sanitizeBackends(raw);
    expect(list).toHaveLength(500);
    expect(list.map((b) => b.id)).toEqual(Array.from({ length: 500 }, (_, i) => `b${i}`));
    expect(list[499]).toMatchObject({ name: "", model: "", language: "auto", endpoint: "stream", hasApiKey: false });
  });

  it("sanitizeProfiles caps at 500 distinct ids, counted after the dedupe, and fills only those", () => {
    const raw: unknown[] = [];
    for (let i = 0; i < 700; i++) raw.push({ id: `p${i}`, name: "", hotkey: [] }, { id: `p${i}`, name: "dup", hotkey: [] });
    raw.push(null, { id: 5 }, { id: "p0", name: "late", hotkey: [] });
    const list = sanitizeProfiles(raw);
    expect(list).toHaveLength(500);
    expect(list.map((p) => p.id)).toEqual(Array.from({ length: 500 }, (_, i) => `p${i}`));
    expect(list[0].name).toBe("");
    expect(list[499]).toMatchObject({ backendId: null });
  });

  it("raises no review row for the alias", () => {
    const incoming = {
      backends: { list: [backend(), backend({ id: ALIAS, serverUrl: "http://evil.example" })], secrets: { [ALIAS]: "x" } },
    } as SyncBlob;
    const local = { backends: { list: [backend()], secrets: {} } } as SyncBlob;
    expect(securityChanges(incoming, local, CATS)).toEqual([]);
    // A genuinely new id is still listed.
    const fresh = { backends: { list: [backend(), backend({ id: "b2", serverUrl: "http://evil.example" })] } } as SyncBlob;
    expect(securityChanges(fresh, local, CATS).map((c) => [c.kind, c.id])).toEqual([["new-backend", "b2"]]);
  });

  it("an apply neither installs the alias nor writes its key, and a profile on it falls back", async () => {
    const blob = {
      backends: { list: [backend(), backend({ id: ALIAS, serverUrl: "http://evil.example" })], secrets: { [ALIAS]: "x" } },
      profiles: { list: [profile(), profile({ id: "p2", backendId: ALIAS, hotkey: ["F10"] })], homeProfileId: null },
    } as unknown as SyncBlob;
    expect(await applyBlob(blob, CATS, 2, { ignoreGates: true })).toBe(true);
    const st = useApp.getState();
    expect(st.backends.map((b) => b.id)).toEqual(["b1"]);
    expect(api.written).not.toContain(ALIAS);
    expect(st.profiles.find((p) => p.id === "p2")?.backendId).toBeNull();
    expect(st.profiles.find((p) => p.id === "p1")?.backendId).toBe("b1");
  });
});
