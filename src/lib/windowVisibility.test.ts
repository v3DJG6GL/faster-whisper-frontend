// The visibility watcher feeds theme.ts's pause reasons; theme.ts is mocked so these cases
// only check which reason is set when.

import { beforeEach, describe, expect, it, vi } from "vitest";

const paused = new Map<string, boolean>();
vi.mock("./theme", () => ({
  setAccentDriftPaused: (reason: string, p: boolean) => void paused.set(reason, p),
}));

import {
  _resetWindowVisibilityForTests,
  isWindowHidden,
  onWindowHiddenChange,
  watchWindowVisibility,
  type VisibilityDeps,
} from "./windowVisibility";

function fakeDoc(state: "visible" | "hidden") {
  const handlers: (() => void)[] = [];
  const doc = {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => void handlers.push(fn),
    set(s: "visible" | "hidden") {
      doc.visibilityState = s;
      for (const h of handlers) h();
    },
  };
  return doc;
}

function fakeTauri(visible: Promise<boolean>) {
  let cb: ((e: { payload: unknown }) => void) | null = null;
  const tauri: NonNullable<VisibilityDeps["tauri"]> = {
    listen: async (_event, fn) => {
      cb = fn;
      return () => {};
    },
    isVisible: () => visible,
  };
  return { tauri, emit: (v: boolean) => cb?.({ payload: v }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watchWindowVisibility", () => {
  beforeEach(() => {
    paused.clear();
    _resetWindowVisibilityForTests();
  });

  it("isWindowHidden is either reason, and listeners hear only real flips", () => {
    const doc = fakeDoc("visible");
    const { tauri, emit } = fakeTauri(new Promise(() => {}));
    const seen: boolean[] = [];
    onWindowHiddenChange((h) => seen.push(h));
    watchWindowVisibility("main", { doc, tauri });
    expect(isWindowHidden()).toBe(false);
    doc.set("hidden");
    emit(false); // a second reason while already hidden: no second notification
    expect(isWindowHidden()).toBe(true);
    doc.set("visible");
    expect(isWindowHidden()).toBe(true); // still hidden by the window reason
    emit(true);
    expect(isWindowHidden()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("a window created hidden boots paused; main does not", () => {
    watchWindowVisibility("quickadd", { doc: fakeDoc("visible") });
    expect(paused.get("window")).toBe(true);
    paused.clear();
    watchWindowVisibility("main", { doc: fakeDoc("visible") });
    expect(paused.has("window")).toBe(false);
  });

  it("follows the page's own visibility", () => {
    const doc = fakeDoc("hidden");
    watchWindowVisibility("main", { doc });
    expect(paused.get("document")).toBe(true);
    doc.set("visible");
    expect(paused.get("document")).toBe(false);
  });

  it("follows Rust's show/hide, and the boot query settles a missed one", async () => {
    const { tauri, emit } = fakeTauri(Promise.resolve(true));
    watchWindowVisibility("overlay", { doc: fakeDoc("visible"), tauri });
    expect(paused.get("window")).toBe(true);
    await flush();
    expect(paused.get("window")).toBe(false); // already shown before the listener existed
    emit(false);
    expect(paused.get("window")).toBe(true);
  });

  it("an event newer than the boot query wins over its answer", async () => {
    let answer!: (v: boolean) => void;
    const { tauri, emit } = fakeTauri(new Promise<boolean>((r) => (answer = r)));
    watchWindowVisibility("quickadd", { doc: fakeDoc("visible"), tauri });
    await flush(); // listener registered, query in flight
    emit(true); // shown while the query was out
    answer(false); // the stale answer says hidden
    await flush();
    expect(paused.get("window")).toBe(false);
  });

  it("a failed query fails open", async () => {
    const { tauri } = fakeTauri(Promise.reject(new Error("ipc")));
    watchWindowVisibility("langpick", { doc: fakeDoc("visible"), tauri });
    await flush();
    expect(paused.get("window")).toBe(false);
  });
});
