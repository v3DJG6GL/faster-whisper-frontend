// Quick-Add's correct-on-close re-types the corrected word after its window has hidden; when
// Rust diverts that insert to the clipboard, the word stays uncorrected and the user's clipboard
// is replaced. The chip says so, as an end-of-session note: Quick-Add emits the bare fact, the
// main window writes the note (showCorrectionCopiedNote), the chip controller shows the window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import quickAddSrc from "../../QuickAdd.tsx?raw";
import appSrc from "../../App.tsx?raw";
import overlaySrc from "../../Overlay.tsx?raw";
import { useApp } from "../store";
import { hideOverlay, showOverlay } from "../api";
import { initOverlayController } from "./chipController";
import { showCorrectionCopiedNote } from "./dictation";
import { CORRECTION_NOTE_HOLD_MS, sessionNoteHoldMs } from "./dictationVisual";

const emit = vi.hoisted(() => vi.fn((_event: string, _payload?: unknown) => Promise.resolve()));
const listen = vi.hoisted(() => vi.fn((_event: string, _cb: (e: { payload: unknown }) => void) => Promise.resolve(() => {})));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  isTauri: true,
  showOverlay: vi.fn(() => Promise.resolve()),
  setOverlayScale: vi.fn(() => Promise.resolve()),
  hideOverlay: vi.fn(() => Promise.resolve()),
  setTrayState: vi.fn(() => Promise.resolve()),
  playCue: vi.fn(() => Promise.resolve()),
}));

type Payload = { sessionNote?: string | null; sessionOutcome?: string | null; translateFailure?: string; partial?: string };
const notes = () =>
  emit.mock.calls.filter((c) => c[0] === "dictation://update").map((c) => (c[1] as Payload).sessionNote ?? null);
const lastUpdate = () => {
  const u = emit.mock.calls.filter((c) => c[0] === "dictation://update");
  return u[u.length - 1]?.[1] as Payload | undefined;
};

/** Chip on an edge, dock off, idle, window HIDDEN; a previous session's leftovers in the store. */
const hiddenIdleChip = async (pos: "top" | "off" = "top") => {
  await initOverlayController();
  vi.useFakeTimers();
  const s = useApp.getState().settings;
  const rec = (indicatorPosition: "top" | "off") => ({
    settings: { ...s, recording: { ...s.recording, indicatorPosition, persistentDock: false } },
  });
  // "off" hides a chip left visible by an earlier test (delay 0), so every test starts hidden.
  useApp.setState({ status: "idle", ...rec("off") });
  vi.advanceTimersByTime(1);
  useApp.setState({
    sessionOutcome: "typed",
    translateFailure: "timeout",
    sessionNote: null,
    partial: "last session's words",
    routePending: null,
    ...rec(pos),
  });
  vi.mocked(showOverlay).mockClear();
  vi.mocked(hideOverlay).mockClear();
  emit.mockClear();
};

describe("showCorrectionCopiedNote — the chip says a correction went to the clipboard", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a hidden chip with the note and the clipboard outcome, then hides it after the note hold", async () => {
    await hiddenIdleChip();
    showCorrectionCopiedNote();
    expect(showOverlay).toHaveBeenCalledTimes(1);
    const p = lastUpdate();
    expect(p?.sessionNote).toBe("correction-copied");
    expect(p?.sessionOutcome).toBe("clipboard");
    // A stale translate failure would turn the pulse into "untranslated"; stale words would take
    // the label slot once the note ends.
    expect(p?.translateFailure).toBe("");
    expect(p?.partial).toBe("");
    // Same hold as the other plain notes, + the window's 200 ms margin.
    expect(sessionNoteHoldMs({ sessionNote: "correction-copied" })).toBe(CORRECTION_NOTE_HOLD_MS);
    vi.advanceTimersByTime(CORRECTION_NOTE_HOLD_MS + 199);
    expect(hideOverlay).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hideOverlay).toHaveBeenCalledTimes(1);
  });

  it("drops the note once it is done, so the next divert is a fresh edge", async () => {
    await hiddenIdleChip();
    showCorrectionCopiedNote();
    vi.advanceTimersByTime(CORRECTION_NOTE_HOLD_MS + 500);
    expect(useApp.getState().sessionNote).toBeNull();
    vi.mocked(showOverlay).mockClear();
    showCorrectionCopiedNote();
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(notes().slice(-3)).toEqual(["correction-copied", null, "correction-copied"]);
  });

  it("re-sends the edge for a repeat inside the hold", async () => {
    await hiddenIdleChip();
    showCorrectionCopiedNote();
    vi.advanceTimersByTime(500);
    showCorrectionCopiedNote();
    expect(notes().slice(-2)).toEqual([null, "correction-copied"]);
  });

  it("never clears a session's own note", async () => {
    await hiddenIdleChip();
    showCorrectionCopiedNote();
    // A session ran and settled with its own note before the drop timer fired.
    useApp.getState().setDictation({ sessionNote: "incomplete" });
    vi.advanceTimersByTime(CORRECTION_NOTE_HOLD_MS + 500);
    expect(useApp.getState().sessionNote).toBe("incomplete");
  });

  it("is skipped while a dictation session is active", async () => {
    await hiddenIdleChip();
    useApp.setState({ status: "listening" });
    emit.mockClear();
    showCorrectionCopiedNote();
    expect(useApp.getState().sessionNote).toBeNull();
    expect(useApp.getState().sessionOutcome).toBe("typed");
    expect(notes()).not.toContain("correction-copied");
    useApp.setState({ status: "idle" });
  });

  it("is skipped while the target picker is open", async () => {
    await hiddenIdleChip();
    useApp.setState({ routePending: "choosing" });
    showCorrectionCopiedNote();
    expect(useApp.getState().sessionNote).toBeNull();
    useApp.setState({ routePending: null });
  });

  it("forces no chip when the user turned it off", async () => {
    await hiddenIdleChip("off");
    showCorrectionCopiedNote();
    expect(showOverlay).not.toHaveBeenCalled();
    expect(notes()).toEqual([]);
  });
});

describe("the correction-copied wire", () => {
  it("Quick-Add emits only on the diverted branch, with no payload", () => {
    const m = /else if \(out\.diverted\) \{([\s\S]*?)\n {2}\}/.exec(quickAddSrc);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("emitCorrectionCopied()");
    expect(quickAddSrc.match(/emitCorrectionCopied\(/g)).toHaveLength(1);
  });

  it("the main window turns it into the note", () => {
    expect(appSrc).toMatch(/onCorrectionCopied\(\(\) => showCorrectionCopiedNote\(\)\)/);
  });

  it("the chip labels the note without naming the word, and pulses clipboard on its edge", () => {
    expect(overlaySrc).toContain('const CORRECTION_COPIED_LABEL = "Correction copied — paste it with Ctrl+V";');
    expect(overlaySrc).toMatch(/note === "correction-copied"\s*\?\s*CORRECTION_COPIED_LABEL/);
    expect(overlaySrc).toMatch(/if \(n === "correction-copied"\) \{[\s\S]*?setPulse\("clipboard"\);/);
  });
});
