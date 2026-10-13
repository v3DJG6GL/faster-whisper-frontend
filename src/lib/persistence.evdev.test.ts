import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `evdevStatus` parks on `release` until a test answers it; every other api call initConfig makes
 *  is a quiet no-op "in Tauri". */
const ipc = vi.hoisted(() => ({
  release: null as null | ((st: { permitted: boolean }) => void),
  fail: null as null | ((e: unknown) => void),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  isTauri: true,
  loadConfig: async () => null,
  saveConfig: async () => {},
  applyLiveSwitches: async () => {},
  reregisterShortcutsUnlessCapturing: async () => {},
  evdevStatus: () =>
    new Promise((resolve, reject) => {
      ipc.release = resolve;
      ipc.fail = reject;
    }),
}));

async function boot() {
  vi.resetModules();
  const persistence = await import("./persistence");
  let ready = false;
  void persistence.configReady.then(() => (ready = true));
  void persistence.initConfig();
  // Let the load and everything up to the evdev wait run.
  await vi.advanceTimersByTimeAsync(0);
  return { persistence, ready: () => ready };
}

describe("evdev permitted bit at startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ipc.release = null;
    ipc.fail = null;
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
});
