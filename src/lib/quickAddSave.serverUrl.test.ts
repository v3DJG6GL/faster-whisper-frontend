// Quick-add reads config.json itself (no store), and the main store's load-time canonicalisation of
// an older build's address is never written back. Both windows must still send ONE address for the
// same backend — a schemeless `nas.lan:8000` sent raw is refused by the Rust transport.

import { describe, expect, it } from "vitest";
import { CONFIG_VERSION, useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { effectiveServerUrl } from "./backends";
import { quickAddServerUrl, quickAddTargetMoved, quickAddTargetOf, quickAddTargetOnLoad, quickAddTargetOnSummon } from "./quickAddSave";
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

  it("is a move when a reload under the override is followed by dropping it", () => {
    // A summon with nothing pending reloads the rows from the override (still a.lan's server),
    // but the load recorded the masked b.lan as where they came from: once a save there failed,
    // dropping the override passed as no move and the retry replaced b.lan's list of the same name.
    const overrides = { a: "http://100.64.0.5:8000" };
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: overrides };
    const viaOverride = quickAddTargetOf(pinned);
    const edited = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);
    edited.settings.sync = { ...edited.settings.sync!, urlOverrides: overrides };
    const dropped = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);

    const reloaded = quickAddTargetOnLoad(viaOverride, edited);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("is a move when a reload under a changed override address and a masked Server URL edit is followed by dropping it", () => {
    // The VPN address changed alongside a Server URL edit the override still masked: the reload
    // (still through the override, so still a.lan's server) recorded b.lan as where the rows came
    // from, the PATCH to the new override address failed, and dropping the override then passed as
    // no move, so the retry replaced b.lan's list of the same name with a.lan's whole map.
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: { a: "http://100.64.0.5:8000" } };
    const viaOverride = quickAddTargetOf(pinned);
    const edited = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);
    edited.settings.sync = { ...edited.settings.sync!, urlOverrides: { a: "http://100.64.0.6:8000" } };
    const dropped = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);

    expect(quickAddTargetOnSummon(viaOverride, edited).moved).toBe(true); // nothing pending: reload
    const reloaded = quickAddTargetOnLoad(viaOverride, edited);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.6:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
    // The save to 100.64.0.6 fails ("error"); the next summon, override dropped, must not follow to b.lan.
    expect(quickAddTargetMoved(reloaded, dropped)).toBe(true);
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("is a move when a reload that adds an override alongside a Server URL edit is followed by dropping it", () => {
    // Loaded without an override from a.lan; the user adds a VPN address that reaches a.lan's server
    // and edits the Server URL to b.lan in the same edit. The reload (through the VPN, so still
    // a.lan's server) recorded b.lan as where the rows came from, the PATCH to the VPN address
    // failed, and dropping the override then passed as no move: the retry replaced b.lan's list of
    // the same name with a.lan's whole map.
    const added = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);
    added.settings.sync = { ...added.settings.sync!, urlOverrides: { a: "http://100.64.0.6:8000" } };
    const dropped = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://b.lan:8000" })]);

    expect(quickAddTargetOnSummon(loaded, added).moved).toBe(true); // nothing pending: reload
    const reloaded = quickAddTargetOnLoad(loaded, added);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.6:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
    expect(quickAddTargetMoved(reloaded, dropped)).toBe(true);
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("keeps the loaded Server URL when only the override address changes on a reload", () => {
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: { a: "http://100.64.0.5:8000" } };
    const moved = cfg({ backendId: "a", slug: "my-words" });
    moved.settings.sync = { ...moved.settings.sync!, urlOverrides: { a: "http://100.64.0.6:8000" } };
    expect(quickAddTargetOnLoad(quickAddTargetOf(pinned), moved)).toEqual(quickAddTargetOf(moved));
  });

  it("adopts the file's Server URL on a reload without an override after it, and keeps the loaded one when an override is added", () => {
    // No override either side: an edited Server URL is where the reload fetched the rows from.
    const readdressed = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]);
    expect(quickAddTargetOnLoad(loaded, readdressed)).toEqual({ serverUrl: "http://a2.lan:8000", backendUrl: "http://a2.lan:8000", backendId: "a", slug: "my-words" });
    expect(quickAddTargetOnLoad(loaded, cfg({ backendId: "a", slug: "my-words" }))).toEqual(loaded);
    // An override added on the reload of an edited Server URL: the rows came through it, so the
    // Server URL it masks is not where they came from, and the loaded one is kept.
    const added = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]);
    added.settings.sync = { ...added.settings.sync!, urlOverrides: { a: "http://100.64.0.6:8000" } };
    expect(quickAddTargetOnLoad(loaded, added)?.backendUrl).toBe("http://a.lan:8000");
    // The override dropped on the reload: the rows came straight from the file's Server URL.
    const pinned = cfg({ backendId: "a", slug: "my-words" });
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: { a: "http://100.64.0.5:8000" } };
    expect(quickAddTargetOnLoad(quickAddTargetOf(pinned), readdressed)).toEqual(quickAddTargetOf(readdressed));
  });

  it("adopts the file's Server URL on a reload at the override's old address once the override is dropped", () => {
    // Loaded from old.lan through the VPN override; the user drops it and sets the Server URL to the
    // VPN address. The reload (same address, no override) kept old.lan as where the rows came from,
    // so once a save failed, the "Address on this device" that recovers it read as a move and the
    // pending rows were thrown away.
    const pinned = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://old.lan:8000" })]);
    pinned.settings.sync = { ...pinned.settings.sync!, urlOverrides: { a: "http://vpn.x:8000" } };
    const viaOverride = quickAddTargetOf(pinned);
    expect(viaOverride).toEqual({ serverUrl: "http://vpn.x:8000", backendUrl: "http://old.lan:8000", backendId: "a", slug: "my-words" });
    const promoted = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://vpn.x:8000" })]);
    const reloaded = quickAddTargetOnLoad(viaOverride, promoted);
    expect(reloaded).toEqual({ serverUrl: "http://vpn.x:8000", backendUrl: "http://vpn.x:8000", backendId: "a", slug: "my-words" });
    // The save to vpn.x fails ("error"); the user adds this device's address lan.y.
    const recovered = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://vpn.x:8000" })]);
    recovered.settings.sync = { ...recovered.settings.sync!, urlOverrides: { a: "http://lan.y:8000" } };
    expect(quickAddTargetOnSummon(reloaded, recovered)).toEqual({
      moved: false,
      target: { serverUrl: "http://lan.y:8000", backendUrl: "http://vpn.x:8000", backendId: "a", slug: "my-words" },
    });
  });

  it("adopts the file's Server URL on a first load, a new address, or another list", () => {
    expect(quickAddTargetOnLoad(null, cfg({ backendId: "a", slug: "my-words" }))).toEqual(loaded);
    const readdressed = cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "a", serverUrl: "http://a2.lan:8000" })]);
    expect(quickAddTargetOnLoad(loaded, readdressed)).toEqual(quickAddTargetOf(readdressed));
    expect(quickAddTargetOnLoad(loaded, cfg({ backendId: "b", slug: "my-words" }))?.backendUrl).toBe("http://b.lan:8000");
    expect(quickAddTargetOnLoad(loaded, cfg(null))).toBeNull();
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
