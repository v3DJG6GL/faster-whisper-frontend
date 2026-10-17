// Quick-add reads config.json itself (no store), and the main store's load-time canonicalisation of
// an older build's address is never written back. Both windows must still send ONE address for the
// same backend — a schemeless `nas.lan:8000` sent raw is refused by the Rust transport.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { effectiveServerUrl } from "./backends";
import { quickAddServerUrl, quickAddTargetMoved, quickAddTargetOf } from "./quickAddSave";
import { backend } from "./sync/syncTestFixtures";
import type { Config, QuickAddTarget } from "./types";

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

describe("quickAddTargetMoved (a re-pin while quick-add holds unsaved rows)", () => {
  function cfg(pin: QuickAddTarget | null, backends = [backend({ id: "a", serverUrl: "http://a.lan:8000" }), backend({ id: "b", serverUrl: "http://b.lan:8000" })]): Config {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.quickAddList = pin;
    return { version: CONFIG_VERSION, settings, backends, profiles: [] };
  }
  const loaded = quickAddTargetOf(cfg({ backendId: "a", slug: "my-words" }));

  it("resolves the pinned list on its backend's address", () => {
    expect(loaded).toEqual({ serverUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
  });

  it("is a move when the pin names another list, another backend, or nothing", () => {
    // The summon gate kept a "rejected"/"error" window on the old list for its whole life: every
    // later mapping was PATCHed to the list the user had re-pinned away from.
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "other" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "b", slug: "my-words" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg(null))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "b" })]))).toBe(true); // backend removed
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]))).toBe(true);
  });

  it("is no move for the same pin, or before anything was loaded", () => {
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }))).toBe(false);
    expect(quickAddTargetMoved(null, cfg({ backendId: "b", slug: "other" }))).toBe(false);
  });
});
