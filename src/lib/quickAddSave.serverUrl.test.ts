// Quick-add reads config.json itself (no store), and the main store's load-time canonicalisation of
// an older build's address is never written back. Both windows must still send ONE address for the
// same backend — a schemeless `nas.lan:8000` sent raw is refused by the Rust transport.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { effectiveServerUrl } from "./backends";
import { quickAddServerUrl, quickAddTargetMoved, quickAddTargetOf, quickAddTargetOnSummon } from "./quickAddSave";
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
    expect(loaded).toEqual({ serverUrl: "http://a.lan:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
  });

  it("is a move when the pin names another list, another backend, or nothing", () => {
    // The summon gate kept a "rejected"/"error" window on the old list for its whole life: every
    // later mapping was PATCHed to the list the user had re-pinned away from.
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "other" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "b", slug: "my-words" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg(null))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "b" })]))).toBe(true); // backend removed
  });

  it("is no move when only this device's address changed, and the summon adopts the new address", () => {
    // A save left on "error" by an unreachable address: the user adds this device's address, and
    // the summon used to read that as a re-pin and re-sync over the unsaved mapping it was holding.
    const overridden = cfg({ backendId: "a", slug: "my-words" });
    overridden.settings.sync = { ...overridden.settings.sync!, urlOverrides: { a: "http://100.64.0.5:8000" } };
    expect(quickAddTargetMoved(loaded, overridden)).toBe(false);
    expect(quickAddTargetOnSummon(loaded, overridden)).toEqual({
      moved: false,
      target: { serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" },
    });
    // The legacy schemeless form of the same Server URL is the same server too.
    const legacy = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "a.lan:8000" })]);
    expect(quickAddTargetMoved(loaded, legacy)).toBe(false);
  });

  it("is a move when the backend's Server URL changed: it may be another server", () => {
    // Retried there, the unsaved rows' whole map replaced that server's list of the same name.
    const readdressed = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]);
    expect(quickAddTargetMoved(loaded, readdressed)).toBe(true);
    expect(quickAddTargetOnSummon(loaded, readdressed)).toEqual({ moved: true, target: loaded });
  });

  it("is no move when the Server URL changed but this device's address override still sends the save there", () => {
    const overrides = { a: "http://100.64.0.5:8000" };
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: overrides };
    const viaOverride = quickAddTargetOf(pinned);
    const edited = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]);
    edited.settings.sync = { ...edited.settings.sync!, urlOverrides: overrides };
    expect(quickAddTargetMoved(viaOverride, edited)).toBe(false);
    expect(quickAddTargetOnSummon(viaOverride, edited)).toEqual({
      moved: false,
      target: { serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" },
    });
  });

  it("is a move when a Server URL edit the override masked is followed by dropping the override", () => {
    // Two summons, each no move on its own, used to add up to the move one summon is refused: the
    // first adopted b.lan as where the rows came from, so the second saw no Server URL change and
    // the next save replaced b.lan's list of the same name with a.lan's whole map.
    const overrides = { a: "http://100.64.0.5:8000" };
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: overrides };
    const viaOverride = quickAddTargetOf(pinned);
    const edited = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);
    edited.settings.sync = { ...edited.settings.sync!, urlOverrides: overrides };
    const dropped = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);

    const s1 = quickAddTargetOnSummon(viaOverride, edited);
    expect(s1.moved).toBe(false);
    const s2 = quickAddTargetOnSummon(s1.target, dropped);
    expect(s2).toEqual({ moved: true, target: viaOverride });
    expect(quickAddTargetOnSummon(viaOverride, dropped).moved).toBe(true);
  });

  it("keeps the loaded target on a move, and has none before anything was loaded", () => {
    expect(quickAddTargetOnSummon(loaded, cfg({ backendId: "b", slug: "my-words" }))).toEqual({ moved: true, target: loaded });
    expect(quickAddTargetOnSummon(null, cfg({ backendId: "a", slug: "my-words" }))).toEqual({ moved: false, target: null });
  });

  it("is no move for the same pin, or before anything was loaded", () => {
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }))).toBe(false);
    expect(quickAddTargetMoved(null, cfg({ backendId: "b", slug: "other" }))).toBe(false);
  });
});
