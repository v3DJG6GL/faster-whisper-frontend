// Quick-add reads config.json itself (no store), and the main store's load-time canonicalisation of
// an older build's address is never written back. Both windows must still send ONE address for the
// same backend — a schemeless `nas.lan:8000` sent raw is refused by the Rust transport.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { effectiveServerUrl } from "./backends";
import { quickAddServerUrl } from "./quickAddSave";
import { backend } from "./sync/syncTestFixtures";

function mainWindowUrl(serverUrl: string): string {
  useApp.getState().hydrate({
    version: CONFIG_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    backends: [backend({ serverUrl, hasApiKey: true })],
    profiles: [],
  });
  const s = useApp.getState();
  return effectiveServerUrl(s.backends[0], s.settings);
}

describe("quickAddServerUrl", () => {
  it.each(["nas.lan:8000", "http:/host.lan:8000", "HTTPS:\\\\srv.example", "ftp://host.lan", "http://ok.lan:8000"])(
    "%s on disk is sent as the main window sends it",
    (raw) => {
      expect(quickAddServerUrl(backend({ serverUrl: raw }), structuredClone(DEFAULT_SETTINGS))).toBe(mainWindowUrl(raw));
    },
  );

  it("sends the legacy schemeless address with its scheme", () => {
    expect(quickAddServerUrl(backend({ serverUrl: "nas.lan:8000" }), structuredClone(DEFAULT_SETTINGS))).toBe(
      "http://nas.lan:8000",
    );
  });

  it("still lets this device's address override win", () => {
    const b = backend({ serverUrl: "nas.lan:8000" });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.sync = { ...settings.sync!, urlOverrides: { [b.id]: "http://10.0.0.5:8000" } };
    expect(quickAddServerUrl(b, settings)).toBe("http://10.0.0.5:8000");
  });
});
