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
  /** Pinned to a/my-words. `serverUrl` re-addresses backend a (then the only backend); `override` is
   *  this device's address for a. */
  function pinA({ serverUrl, override }: { serverUrl?: string; override?: string } = {}): Config {
    const c = cfg({ backendId: "a", slug: "my-words" }, serverUrl === undefined ? undefined : [backend({ id: "a", serverUrl })]);
    if (override !== undefined) c.settings.sync = { ...c.settings.sync!, urlOverrides: { a: override } };
    return c;
  }
  const loaded = quickAddTargetOf(pinA());

  it("resolves the pinned list on its backend's address", () => {
    expect(loaded).toEqual({ serverUrl: "http://a.lan:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
  });

  it("is a move when the pin names another list, another backend, or nothing", () => {
    // Read as no move, a "rejected"/"error" window would stay on the old list for good, PATCHing
    // every later mapping to the list the user re-pinned away from.
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "other" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "b", slug: "my-words" }))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg(null))).toBe(true);
    expect(quickAddTargetMoved(loaded, cfg({ backendId: "a", slug: "my-words" }, [backend({ id: "b" })]))).toBe(true); // backend removed
  });

  it("is no move when only this device's address changed, and the summon adopts the new address", () => {
    // Adding this device's address is how the user recovers a save left on "error" by an unreachable
    // address; read as a re-pin, the summon would re-sync over the unsaved mapping it holds.
    const overridden = pinA({ override: "http://100.64.0.5:8000" });
    expect(quickAddTargetMoved(loaded, overridden)).toBe(false);
    expect(quickAddTargetOnSummon(loaded, overridden)).toEqual({
      moved: false,
      target: { serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" },
    });
    // The legacy schemeless form of the same Server URL is the same server too.
    const legacy = pinA({ serverUrl: "a.lan:8000" });
    expect(quickAddTargetMoved(loaded, legacy)).toBe(false);
  });

  it("is a move when the backend's Server URL changed: it may be another server", () => {
    // Retried there, the unsaved rows' whole map would replace that server's list of the same name.
    const readdressed = pinA({ serverUrl: "http://a2.lan:8000" });
    expect(quickAddTargetMoved(loaded, readdressed)).toBe(true);
    expect(quickAddTargetOnSummon(loaded, readdressed)).toEqual({ moved: true, target: loaded });
  });

  it("is no move when the Server URL changed but this device's address override still sends the save there", () => {
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    const edited = pinA({ serverUrl: "http://a2.lan:8000", override: "http://100.64.0.5:8000" });
    expect(quickAddTargetMoved(viaOverride, edited)).toBe(false);
    expect(quickAddTargetOnSummon(viaOverride, edited)).toEqual({
      moved: false,
      target: { serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" },
    });
  });

  it("is a move when a Server URL edit the override masked is followed by dropping the override", () => {
    // Two summons, each no move on its own, must not add up to the move one summon is refused: had
    // the first adopted b.lan as where the rows came from, the second would see no Server URL change
    // and the next save would replace b.lan's list of the same name with a.lan's whole map.
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    const edited = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.5:8000" });
    const dropped = pinA({ serverUrl: "http://b.lan:8000" });

    const s1 = quickAddTargetOnSummon(viaOverride, edited);
    expect(s1.moved).toBe(false);
    const s2 = quickAddTargetOnSummon(s1.target, dropped);
    expect(s2).toEqual({ moved: true, target: viaOverride });
    expect(quickAddTargetOnSummon(viaOverride, dropped).moved).toBe(true);
  });

  it("is a move when a reload under the override is followed by dropping it", () => {
    // A summon with nothing pending reloads the rows from the override (still a.lan's server). Had
    // the load recorded the masked b.lan as where they came from, dropping the override after a
    // failed save would pass as no move and the retry would replace b.lan's list of the same name.
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    const edited = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.5:8000" });
    const dropped = pinA({ serverUrl: "http://b.lan:8000" });

    const reloaded = quickAddTargetOnLoad(viaOverride, edited);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.5:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words" });
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("is a move when a reload under a changed override address and a masked Server URL edit is followed by dropping it", () => {
    // The VPN address changes alongside a Server URL edit the override still masks. Had the reload
    // (still through the override, so still a.lan's server) recorded b.lan as where the rows came
    // from, then after a failed PATCH to the new override address, dropping the override would pass
    // as no move and the retry would replace b.lan's list of the same name with a.lan's whole map.
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    const edited = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.6:8000" });
    const dropped = pinA({ serverUrl: "http://b.lan:8000" });

    expect(quickAddTargetOnSummon(viaOverride, edited).moved).toBe(true); // nothing pending: reload
    const reloaded = quickAddTargetOnLoad(viaOverride, edited);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.6:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words", originUnknown: true });
    // The save to 100.64.0.6 fails ("error"); the next summon, override dropped, must not follow to b.lan.
    expect(quickAddTargetMoved(reloaded, dropped)).toBe(true);
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("is a move when a reload that adds an override alongside a Server URL edit is followed by dropping it", () => {
    // Loaded without an override from a.lan; the user adds a VPN address that reaches a.lan's server
    // and edits the Server URL to b.lan in the same edit. Had the reload (through the VPN, so still
    // a.lan's server) recorded b.lan as where the rows came from, then after a failed PATCH to the
    // VPN address, dropping the override would pass as no move and the retry would replace b.lan's
    // list of the same name with a.lan's whole map.
    const added = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.6:8000" });
    const dropped = pinA({ serverUrl: "http://b.lan:8000" });

    expect(quickAddTargetOnSummon(loaded, added).moved).toBe(true); // nothing pending: reload
    const reloaded = quickAddTargetOnLoad(loaded, added);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.6:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words", originUnknown: true });
    expect(quickAddTargetMoved(reloaded, dropped)).toBe(true);
    expect(quickAddTargetOnSummon(reloaded, dropped)).toEqual({ moved: true, target: reloaded });
  });

  it("is a move when a reload that edits the Server URL and the override together is followed by undoing both", () => {
    // Loaded from a.lan without an override; the user edits the Server URL to b.lan and adds a VPN
    // address in one go. The reload keeps a.lan, but the rows came from whichever server the VPN
    // address reaches — maybe b.lan's. Taken as where the rows came from, undoing both edits after
    // a failed save would pass as no move (a.lan against a.lan), and the retry would replace a.lan's
    // list with rows from the other server.
    const added = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.6:8000" });
    const undone = pinA();

    const reloaded = quickAddTargetOnLoad(loaded, added);
    expect(reloaded).toEqual({ serverUrl: "http://100.64.0.6:8000", backendUrl: "http://a.lan:8000", backendId: "a", slug: "my-words", originUnknown: true });
    expect(quickAddTargetMoved(reloaded, undone)).toBe(true);
    expect(quickAddTargetOnSummon(reloaded, undone)).toEqual({ moved: true, target: reloaded });

    // The same with an override re-addressed (not added) alongside the Server URL edit, then both undone.
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    const readdressed = quickAddTargetOnLoad(viaOverride, added);
    expect(readdressed?.originUnknown).toBe(true);
    expect(quickAddTargetMoved(readdressed, pinned)).toBe(true);
  });

  it("keeps an unknown origin through later reloads under the override, and only its own address is no move", () => {
    const added = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.6:8000" });
    const undone = pinA();
    const unknown = quickAddTargetOnLoad(loaded, added);

    // A reload with nothing changed still fetches through the override, from that same unknown server.
    const again = quickAddTargetOnLoad(unknown, added);
    expect(again).toEqual(unknown);
    expect(quickAddTargetMoved(again, undone)).toBe(true);
    // A new address on this device alone is a move too: nothing says it reaches the rows' server.
    const vpn7 = pinA({ serverUrl: "http://b.lan:8000", override: "http://100.64.0.7:8000" });
    expect(quickAddTargetOnSummon(unknown, vpn7)).toEqual({ moved: true, target: unknown });
    // The very address the rows came from is no move, whatever the Server URL says, and stays unknown.
    const c = pinA({ serverUrl: "http://c.lan:8000", override: "http://100.64.0.6:8000" });
    expect(quickAddTargetOnSummon(unknown, c)).toEqual({ moved: false, target: unknown });
    // A reload without an override fetches from the file's own Server URL: the origin is known again.
    expect(quickAddTargetOnLoad(unknown, undone)).toEqual(loaded);
    expect(quickAddTargetOnLoad(unknown, undone)).not.toHaveProperty("originUnknown");
  });

  it("leaves a known origin unmarked: a plain reload, or one that changes only the override, is no move", () => {
    const same = quickAddTargetOnLoad(loaded, pinA());
    expect(same).not.toHaveProperty("originUnknown");
    expect(quickAddTargetMoved(same, pinA())).toBe(false);
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const vpn6 = pinA({ override: "http://100.64.0.6:8000" });
    const reloaded = quickAddTargetOnLoad(quickAddTargetOf(pinned), vpn6);
    expect(reloaded).not.toHaveProperty("originUnknown");
    expect(quickAddTargetMoved(reloaded, pinned)).toBe(false);
  });

  it("keeps the loaded Server URL when only the override address changes on a reload", () => {
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    const moved = pinA({ override: "http://100.64.0.6:8000" });
    expect(quickAddTargetOnLoad(quickAddTargetOf(pinned), moved)).toEqual(quickAddTargetOf(moved));
  });

  it("adopts the file's Server URL on a reload without an override after it, and keeps the loaded one when an override is added", () => {
    // No override either side: an edited Server URL is where the reload fetched the rows from.
    const readdressed = pinA({ serverUrl: "http://a2.lan:8000" });
    expect(quickAddTargetOnLoad(loaded, readdressed)).toEqual({ serverUrl: "http://a2.lan:8000", backendUrl: "http://a2.lan:8000", backendId: "a", slug: "my-words" });
    expect(quickAddTargetOnLoad(loaded, pinA())).toEqual(loaded);
    // An override added on the reload of an edited Server URL: the rows came through it, so the
    // Server URL it masks is not where they came from, and the loaded one is kept.
    const added = pinA({ serverUrl: "http://a2.lan:8000", override: "http://100.64.0.6:8000" });
    expect(quickAddTargetOnLoad(loaded, added)?.backendUrl).toBe("http://a.lan:8000");
    // The override dropped on the reload: the rows came straight from the file's Server URL.
    const pinned = pinA({ override: "http://100.64.0.5:8000" });
    expect(quickAddTargetOnLoad(quickAddTargetOf(pinned), readdressed)).toEqual(quickAddTargetOf(readdressed));
  });

  it("adopts the file's Server URL on a reload at the override's old address once the override is dropped", () => {
    // Loaded from old.lan through the VPN override; the user drops it and sets the Server URL to the
    // VPN address. Had the reload (same address, no override) kept old.lan as where the rows came
    // from, then once a save failed, the "Address on this device" that recovers it would read as a
    // move and throw the pending rows away.
    const pinned = pinA({ serverUrl: "http://old.lan:8000", override: "http://vpn.x:8000" });
    const viaOverride = quickAddTargetOf(pinned);
    expect(viaOverride).toEqual({ serverUrl: "http://vpn.x:8000", backendUrl: "http://old.lan:8000", backendId: "a", slug: "my-words" });
    const promoted = pinA({ serverUrl: "http://vpn.x:8000" });
    const reloaded = quickAddTargetOnLoad(viaOverride, promoted);
    expect(reloaded).toEqual({ serverUrl: "http://vpn.x:8000", backendUrl: "http://vpn.x:8000", backendId: "a", slug: "my-words" });
    // The save to vpn.x fails ("error"); the user adds this device's address lan.y.
    const recovered = pinA({ serverUrl: "http://vpn.x:8000", override: "http://lan.y:8000" });
    expect(quickAddTargetOnSummon(reloaded, recovered)).toEqual({
      moved: false,
      target: { serverUrl: "http://lan.y:8000", backendUrl: "http://vpn.x:8000", backendId: "a", slug: "my-words" },
    });
  });

  it("adopts the file's Server URL on a first load, a new address, or another list", () => {
    expect(quickAddTargetOnLoad(null, pinA())).toEqual(loaded);
    const readdressed = pinA({ serverUrl: "http://a2.lan:8000" });
    expect(quickAddTargetOnLoad(loaded, readdressed)).toEqual(quickAddTargetOf(readdressed));
    expect(quickAddTargetOnLoad(loaded, cfg({ backendId: "b", slug: "my-words" }))?.backendUrl).toBe("http://b.lan:8000");
    expect(quickAddTargetOnLoad(loaded, cfg(null))).toBeNull();
  });

  it("keeps the loaded target on a move, and has none before anything was loaded", () => {
    expect(quickAddTargetOnSummon(loaded, cfg({ backendId: "b", slug: "my-words" }))).toEqual({ moved: true, target: loaded });
    expect(quickAddTargetOnSummon(null, pinA())).toEqual({ moved: false, target: null });
  });

  it("is no move for the same pin, or before anything was loaded", () => {
    expect(quickAddTargetMoved(loaded, pinA())).toBe(false);
    expect(quickAddTargetMoved(null, cfg({ backendId: "b", slug: "other" }))).toBe(false);
  });
});
