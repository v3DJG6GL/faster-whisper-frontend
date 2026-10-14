import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IS_WINDOWS } from "./platform";
import type { Profile } from "./types";

/** `evdevStatus` parks on `release` until a test answers it; a save parks on `landSave` while
 *  `parkSaves` is set; every other api call initConfig makes is a quiet no-op "in Tauri". */
const ipc = vi.hoisted(() => ({
  release: null as null | ((st: { permitted: boolean }) => void),
  fail: null as null | ((e: unknown) => void),
  saves: 0,
  saved: [] as { profiles: unknown[] }[],
  parkSaves: false,
  landSave: null as null | (() => void),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  isTauri: true,
  loadConfig: async () => null,
  saveConfig: async (cfg: { profiles: unknown[] }) => {
    ipc.saves += 1;
    ipc.saved.push(cfg);
    if (ipc.parkSaves) await new Promise<void>((r) => (ipc.landSave = r));
  },
  applyLiveSwitches: async () => {},
  reregisterShortcutsUnlessCapturing: async () => {},
  evdevStatus: () =>
    new Promise((resolve, reject) => {
      ipc.release = resolve;
      ipc.fail = reject;
    }),
}));

async function boot(before?: (store: typeof import("./store")) => void) {
  vi.resetModules();
  const persistence = await import("./persistence");
  const store = await import("./store");
  before?.(store);
  let ready = false;
  void persistence.configReady.then(() => (ready = true));
  void persistence.initConfig();
  // Let the load and everything up to the evdev wait run.
  await vi.advanceTimersByTimeAsync(0);
  return { persistence, store, ready: () => ready };
}

describe("evdev permitted bit at startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.release = null;
    ipc.fail = null;
    ipc.saves = 0;
    ipc.saved = [];
    ipc.parkSaves = false;
    ipc.landSave = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("while unknown, a sync apply does not collapse sides but the save gate does", async () => {
    const { persistence } = await boot();
    expect(persistence.evdevPermittedNow()).toBe(true);
    expect(persistence.evdevPermittedFor("apply")).toBe(true);
    expect(persistence.evdevPermittedFor("save")).toBe(false);
    ipc.release!({ permitted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(persistence.evdevPermittedFor("apply")).toBe(true);
    expect(persistence.evdevPermittedFor("save")).toBe(true);
  });

  it("a status that says not permitted collapses for both", async () => {
    const { persistence } = await boot();
    ipc.release!({ permitted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(persistence.evdevPermittedNow()).toBe(false);
    expect(persistence.evdevPermittedFor("save")).toBe(false);
  });

  it("configReady waits for the evdev status, so the startup pull sees the real bit", async () => {
    const { ready } = await boot();
    await vi.advanceTimersByTimeAsync(500);
    expect(ready()).toBe(false);
    ipc.release!({ permitted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready()).toBe(true);
  });

  it("a hung or failed evdev status holds configReady only up to its cap, and stays unknown", async () => {
    const hung = await boot();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(hung.ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(hung.ready()).toBe(true);
    expect(hung.persistence.evdevPermittedNow()).toBe(true);

    const failed = await boot();
    ipc.fail!(new Error("ipc"));
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.ready()).toBe(true);
    expect(failed.persistence.evdevPermittedFor("apply")).toBe(true);
    expect(failed.persistence.evdevPermittedFor("save")).toBe(false);
  });

  // Run #76 F11-1: a save the gate held while the bit was unknown (collapse ⇒ an L/R-only pair
  // reads as a conflict) is re-checked once the bit is known — before, the false "used by two
  // bindings" freeze stayed until an unrelated edit.
  const pair = [
    { id: "p1", name: "Left", activation: "hold", enabled: true, hotkey: ["ControlLeft", "Space"], backendId: null },
    { id: "p2", name: "Right", activation: "hold", enabled: true, hotkey: ["ControlRight", "Space"], backendId: null },
  ] as unknown as Profile[];
  const withEvdev = (on: boolean) => (store: typeof import("./store")) =>
    store.useApp.setState((s) => ({ settings: { ...s.settings, general: { ...s.settings.general, evdevEnabled: on } } }));

  it.runIf(!IS_WINDOWS)("a save held while the status was unknown lands once it says permitted", async () => {
    const { persistence, store } = await boot((st) => {
      withEvdev(true)(st);
      st.useApp.setState({ profiles: pair });
    });
    await vi.advanceTimersByTimeAsync(2_000); // past the startup cap: still unknown
    store.useApp.setState({ profiles: [...pair] });
    await vi.advanceTimersByTimeAsync(400);
    expect(persistence.configSaveHeld()).toBe(true);
    expect(store.useApp.getState().saveError).toMatch(/two bindings/);
    expect(ipc.saves).toBe(0);
    ipc.release!({ permitted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.saves).toBe(1);
    expect(persistence.configSaveHeld()).toBe(false);
    expect(store.useApp.getState().saveError).toBeNull();
  });

  it.runIf(!IS_WINDOWS)("the evdev toggle's late answer re-checks the save it held", async () => {
    const { persistence, store } = await boot((st) => st.useApp.setState({ profiles: pair }));
    ipc.release!({ permitted: false });
    await vi.advanceTimersByTimeAsync(0);
    withEvdev(true)(store);
    await vi.advanceTimersByTimeAsync(400);
    expect(persistence.configSaveHeld()).toBe(true);
    ipc.release!({ permitted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.saves).toBe(1);
    expect(persistence.configSaveHeld()).toBe(false);
  });

  // Run #77 F11-1: an OLDER write still in flight when the status flips the collapse — the flush
  // used to await only that write, and the freeze that held the newer edit stayed.
  it.runIf(!IS_WINDOWS)("a held save re-runs once the status is known even while an older write is in flight", async () => {
    const { persistence, store } = await boot((st) => {
      withEvdev(true)(st);
      st.useApp.setState({ profiles: [pair[0]] });
    });
    await vi.advanceTimersByTimeAsync(2_000); // past the startup cap: still unknown
    ipc.parkSaves = true;
    store.useApp.setState({ profiles: [{ ...pair[0], name: "Left hand" }] });
    await vi.advanceTimersByTimeAsync(400); // save A: writing, parked
    expect(ipc.saves).toBe(1);
    const landA = ipc.landSave!;
    ipc.parkSaves = false;
    store.useApp.setState({ profiles: pair });
    await vi.advanceTimersByTimeAsync(400); // save B: frozen as an L/R-only "conflict"
    expect(persistence.configSaveHeld()).toBe(true);
    expect(ipc.saves).toBe(1);
    ipc.release!({ permitted: true });
    await vi.advanceTimersByTimeAsync(0);
    landA();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.saves).toBe(2);
    expect(ipc.saved[1].profiles).toHaveLength(2);
    expect(persistence.configSaveHeld()).toBe(false);
    expect(store.useApp.getState().saveError).toBeNull();
  });
});
