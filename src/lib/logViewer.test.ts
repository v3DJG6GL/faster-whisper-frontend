// The invariant every Logs.tsx memo silently depends on: what `visibleLines()`
// returns must be a NEW array whenever the version bumps.
//
// It once wasn't. With no "Clear view" floor the accessor handed back the
// module-level `buf` itself, which `append()` mutates in place — so the
// reference never changed and `useMemo(..., [all])` kept its first result
// forever. The screen rendered the snapshot it took at mount (empty, before
// hydration): no lines, no subsystem chips, no live tail, no "N new lines"
// pill, and a bug report that copied nothing. Only touching a filter — a
// different dependency — brought the view back.

import { describe, expect, it, vi } from "vitest";
import type { LogLine } from "./api";

function line(seq: number): LogLine {
  return { seq, ts: 1000 + seq, level: "info", target: "t", tag: "pipeline", msg: `m${seq}` };
}

let emit: ((p: { lines: LogLine[] }) => void) | null = null;
const streamCalls: boolean[] = [];
let failNextTail = false;

vi.mock("./api", () => ({
  getLogStatus: async () => ({ seq: 0, errors: 0, warns: 0 }),
  getLogTail: async () => {
    if (failNextTail) {
      failNextTail = false;
      throw new Error("ipc down");
    }
    return { seq: 2, errors: 0, warns: 0, lines: [line(0), line(1)] };
  },
  onLogLines: async (cb: (p: { lines: LogLine[] }) => void) => {
    emit = cb;
    return () => {
      emit = null;
    };
  },
  onLogStatus: async () => () => {},
  setLogStream: async (active: boolean) => {
    streamCalls.push(active);
  },
}));

const vis = vi.hoisted(() => ({ hidden: false, listeners: new Set<(h: boolean) => void>() }));
vi.mock("./windowVisibility", () => ({
  isWindowHidden: () => vis.hidden,
  onWindowHiddenChange: (fn: (h: boolean) => void) => {
    vis.listeners.add(fn);
    return () => void vis.listeners.delete(fn);
  },
}));
function setHidden(h: boolean) {
  vis.hidden = h;
  for (const fn of [...vis.listeners]) fn(h);
}

const { attachLogStream, clearView, visibleLines, useLogs } = await import("./logViewer");

describe("visibleLines", () => {
  it("hands back a fresh array on every version bump, so memos keyed on it invalidate", async () => {
    const empty = visibleLines();
    expect(empty).toHaveLength(0);

    const detach = await attachLogStream();
    const hydrated = visibleLines();
    expect(hydrated).toHaveLength(2);
    expect(hydrated).not.toBe(empty);

    // Same version → same reference (one allocation per batch, not per render).
    expect(visibleLines()).toBe(hydrated);

    emit?.({ lines: [line(2)] });
    const appended = visibleLines();
    expect(appended).toHaveLength(3);
    expect(appended).not.toBe(hydrated);
    // The stale snapshot must not have grown underneath its holder either.
    expect(hydrated).toHaveLength(2);

    clearView();
    const cleared = visibleLines();
    expect(cleared).toHaveLength(0);
    expect(cleared).not.toBe(appended);

    detach();
  });
});

describe("attachLogStream ownership", () => {
  it("a stale detach from a superseded attach never turns the live stream off", async () => {
    streamCalls.length = 0;
    const p1 = attachLogStream();
    const p2 = attachLogStream();
    (await p1)();
    // mount1's detach ran AFTER mount2 attached: it must not send `false`.
    expect(streamCalls[streamCalls.length - 1]).toBe(true);
    (await p2)();
    expect(streamCalls[streamCalls.length - 1]).toBe(false);
  });

  it("rolls the listener back when hydration rejects", async () => {
    failNextTail = true;
    const before = visibleLines().length;
    await expect(attachLogStream()).rejects.toThrow("ipc down");
    expect(emit).toBeNull(); // unlisten ran
    emit?.({ lines: [line(9)] });
    expect(visibleLines().length).toBe(before);
  });
});

describe("attachLogStream while the window is hidden", () => {
  it("holds batches without bumping the version, then replays them in order on show", async () => {
    const detach = await attachLogStream();
    const before = visibleLines().length;
    // Well past anything earlier cases appended (append drops already-seen seqs).
    const lastSeq = 100;
    const version = useLogs.getState().version;

    setHidden(true);
    emit?.({ lines: [line(lastSeq + 1)] });
    emit?.({ lines: [line(lastSeq + 2)] });
    expect(useLogs.getState().version).toBe(version);
    expect(visibleLines()).toHaveLength(before);

    setHidden(false);
    const shown = visibleLines();
    expect(shown.slice(before).map((l) => l.seq)).toEqual([lastSeq + 1, lastSeq + 2]);

    // Live again once shown.
    emit?.({ lines: [line(lastSeq + 3)] });
    expect(visibleLines()).toHaveLength(before + 3);

    detach();
    expect(vis.listeners.size).toBe(0);
  });
});
