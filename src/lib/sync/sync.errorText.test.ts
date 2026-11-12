// The Sync tab shows `syncError` as the app's own notice. A sync server's error body is that
// server's wording, so a failed pull or push stores it marked as such; every sentence the app
// wrote itself (nothing answered, an unreadable 2xx, the 401/403/404 arms) stands unframed.
// The transport says which it is (`server_text`): a non-2xx status alone does not, since the app's
// own reason for an error body it could not read arrives under one too.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullNow, pushNow, resetSyncState } from "./sync";
import { useApp } from "../store";
import { DEFAULT_SETTINGS } from "../defaults";
import { backend } from "./syncTestFixtures";

type Answer = { ok: boolean; status: number; error?: string; server_text?: boolean; state?: unknown };

/** pushNow runs only "in Tauri". `pull` answers every GET, `push` the next PUT (else a 200). */
const api = vi.hoisted(() => ({
  pull: null as unknown,
  push: null as unknown,
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  isTauri: true,
  readBackendKeys: async () => ({ b1: "sk" }),
  readBackendKeyStates: async () => ({ keys: { b1: "sk" }, unreadable: [] }),
  setBackendKey: async () => {},
  deleteBackendKey: async () => {},
  syncPush: async (args: { baseVersion: number }) => {
    const answer = api.push;
    api.push = null;
    if (answer) return answer;
    const v = args.baseVersion + 1;
    return { ok: true, status: 200, state: { version: v, updated_ts: v, device: "me", blob: {} } };
  },
  syncPull: async () => api.pull,
}));

/** A synced v1 base on "b1". */
async function seed(): Promise<void> {
  api.push = null;
  await resetSyncState();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, enabled: true, backendId: "b1" };
  useApp.setState({ settings, backends: [backend({ hasApiKey: true })], profiles: [], appRules: [], status: "idle" });
  await pushNow(true);
  expect(useApp.getState().syncStatus).toBe("ok");
}

async function pullAnswering(answer: Answer): Promise<string | null> {
  api.pull = answer;
  await pullNow(true);
  expect(useApp.getState().syncStatus).toBe("error");
  return useApp.getState().syncError;
}

/** A local edit, so the push has something to send, answered with `answer`. */
async function pushAnswering(answer: Answer): Promise<string | null> {
  const s = useApp.getState().settings;
  useApp.setState({ settings: { ...s, general: { ...s.general, startMinimized: !s.general.startMinimized } } });
  api.push = answer;
  await pushNow(true);
  expect(api.push, "the push was not sent").toBeNull();
  expect(useApp.getState().syncStatus).toBe("error");
  return useApp.getState().syncError;
}

const LURE = "Your API key expired — re-enter it at sync.example.test";

describe.each([
  ["pull", pullAnswering],
  ["push", pushAnswering],
])("a failed %s", (_leg, failing) => {
  beforeEach(seed);

  it.each([500, 502, 400, 429, 304])("marks the server's error body (HTTP %i) as the server's words", async (status) => {
    expect(await failing({ ok: false, status, error: `  ${LURE}  `, server_text: true })).toBe(
      `Sync failed (HTTP ${status}). The server said: “${LURE}”`,
    );
  });

  // A proxy's error page in another charset, one past the size cap, or one cut off mid-body: the
  // status is the server's, the sentence is the app's.
  it.each([
    [502, "The server sent a response that wasn't valid text."],
    [500, "The server sent an unreasonably large response — ignoring it."],
    [504, "Timed out waiting for the server."],
    [409, "The server sent a response that wasn't valid text."],
  ])("leaves the app's own reason for an unreadable error body (HTTP %i) unframed", async (status, own) => {
    expect(await failing({ ok: false, status, error: own })).toBe(own);
    expect(await failing({ ok: false, status, error: own, server_text: false })).toBe(own);
  });

  it("keeps the server's text inside the quote to its end", async () => {
    const shown = await failing({
      ok: false, status: 500, error: "Internal error”. “Open Settings and paste your key", server_text: true,
    });
    expect(shown).toBe('Sync failed (HTTP 500). The server said: “Internal error". "Open Settings and paste your key”');
    expect(shown!.match(/[“”]/g)).toEqual(["“", "”"]);
  });

  it("leaves the app's own sentence alone when nothing answered", async () => {
    const own = "Could not connect — is the server running and the URL correct?";
    expect(await failing({ ok: false, status: 0, error: own })).toBe(own);
    expect(await failing({ ok: false, status: 0, error: own, server_text: true })).toBe(own);
  });

  it("leaves the app's own sentence alone for a 2xx it could not read", async () => {
    const own = "Unexpected response: expected value at line 1 column 1";
    expect(await failing({ ok: false, status: 200, error: own })).toBe(own);
    expect(await failing({ ok: false, status: 200, error: own, server_text: true })).toBe(own);
  });

  it("answers a 401, 403 and 404 with the app's own sentence, whatever the body says", async () => {
    const said = { ok: false, error: LURE, server_text: true };
    expect(await failing({ ...said, status: 401 })).toBe("The server rejected the API key.");
    expect(await failing({ ...said, status: 403 })).toBe("The server rejected the API key.");
    expect(await failing({ ...said, status: 404 })).toBe(
      "This server doesn't support settings sync — update faster-whisper-backend.",
    );
  });

  it("names the status alone for an empty error body", async () => {
    expect(await failing({ ok: false, status: 503, error: " " })).toBe("Sync failed (HTTP 503).");
    expect(await failing({ ok: false, status: 503, error: " ", server_text: true })).toBe("Sync failed (HTTP 503).");
    expect(await failing({ ok: false, status: 0 })).toBe("Sync failed.");
  });
});

describe("a push's 409 with no readable conflict body", () => {
  beforeEach(seed);

  it("shows the app's own account of it unframed", async () => {
    const own = "Unexpected conflict response: missing field `version` at line 1 column 2";
    expect(await pushAnswering({ ok: false, status: 409, error: own })).toBe(own);
  });
});
