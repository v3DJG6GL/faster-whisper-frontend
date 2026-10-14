// A lenient http(s) address an older build stored verbatim (`http:/host:8000`) loads in the
// spelling the sync sanitizer gives a peer's copy of it, so the same host on both sides compares
// equal: no "server-url" consent row on every pull, no "moved" key in the restore dialog.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { backendKeyFates, categorySelection, sanitizeBackends, securityChanges } from "./sync/sync";
import { backend } from "./sync/syncTestFixtures";
import type { SyncBlob } from "./sync/syncTypes";

const LEGACY: [string, string][] = [
  ["http:/host.lan:8000", "http://host.lan:8000"],
  ["HTTPS:\\\\srv.example", "https://srv.example"],
  ["http:host.lan:8000", "http://host.lan:8000"],
];

function load(serverUrl: string) {
  useApp.getState().hydrate({
    version: CONFIG_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    backends: [backend({ serverUrl, hasApiKey: true })],
    profiles: [],
  });
  return useApp.getState().backends;
}

describe("a legacy lenient serverUrl on this device", () => {
  it.each(LEGACY)("%s loads in its canonical form", (raw, canonical) => {
    expect(load(raw)[0].serverUrl).toBe(canonical);
  });

  it.each(LEGACY)("%s raises no server-url row against the same peer copy", (raw) => {
    const local = load(raw);
    const incoming = { backends: { list: [backend({ serverUrl: raw, hasApiKey: true })] } } as unknown as SyncBlob;
    const here = { backends: { list: local } } as unknown as SyncBlob;
    expect(securityChanges(incoming, here, categorySelection(true)).filter((c) => c.kind === "server-url")).toEqual([]);
  });

  it.each(LEGACY)("%s is not reported as a moved key on restore", (raw) => {
    const local = load(raw);
    // The restore dialog judges the list the restore installs: the sanitized peer copy.
    const fates = backendKeyFates(
      sanitizeBackends([backend({ serverUrl: raw, hasApiKey: true })]),
      undefined,
      local,
      useApp.getState().settings,
    );
    expect(fates.moved).toEqual([]);
  });

  it("an unsupported scheme stays verbatim", () => {
    expect(load("ftp://host.lan")[0].serverUrl).toBe("ftp://host.lan");
  });
});
