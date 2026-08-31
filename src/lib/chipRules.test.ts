// The chip's expand / tuck / cancel decisions. There is no jsdom and no component
// test in this repo, so these matrices are the ONLY coverage the chip's behaviour
// gets — which is why the rules were extracted from Overlay.tsx in the first place.

import { describe, expect, it } from "vitest";
import {
  CANCEL_AFFORDANCE_DELAY_MS, PHASE_PERSIST_MS, chipCancelVisible, chipExpansion, chipTuckHold,
  currentPhase, phaseClock, phaseElapsedMs,
} from "./chipRules";
import type { DictationPhase, DictationStatus } from "./types";

const NOW = 1_700_000_000_000;
const phase = (over: Partial<DictationPhase> = {}): DictationPhase => ({
  kind: "translating",
  label: "Translating…",
  startedAt: NOW,
  ...over,
});

const PROCESSING: DictationStatus[] = ["transcribing", "translating", "injecting"];

describe("chipExpansion", () => {
  it("expands for error and warm-up regardless of anything else", () => {
    expect(chipExpansion({ status: "error", speaking: false, expanded: false, now: NOW })).toBe(true);
    expect(
      chipExpansion({ status: "listening", warming: true, speaking: false, expanded: false, now: NOW }),
    ).toBe(true);
  });

  it("expands while listening only when speaking", () => {
    expect(chipExpansion({ status: "listening", speaking: true, expanded: false, now: NOW })).toBe(true);
    expect(chipExpansion({ status: "listening", speaking: false, expanded: true, now: NOW })).toBe(false);
  });

  it("never expands at idle", () => {
    expect(chipExpansion({ status: "idle", speaking: true, expanded: true, now: NOW })).toBe(false);
  });

  it("sustains an open pill through every processing state", () => {
    for (const status of PROCESSING) {
      expect(chipExpansion({ status, speaking: false, expanded: true, now: NOW }), status).toBe(true);
    }
  });

  // The anti-glitch rule, verbatim: a sub-second state must never pop a minimized chip.
  it("does not pop a minimized chip for a phase-less processing state", () => {
    for (const status of PROCESSING) {
      expect(chipExpansion({ status, speaking: false, expanded: false, now: NOW }), status).toBe(false);
    }
  });

  it("pops a minimized chip for a phase known to be cold", () => {
    expect(
      chipExpansion({
        status: "translating",
        speaking: false,
        expanded: false,
        phase: phase({ cold: true }),
        now: NOW, // no elapsed time at all — `cold` alone earns it
      }),
    ).toBe(true);
  });

  it("pops a minimized chip once a phase outlasts the anti-glitch window", () => {
    const p = phase();
    expect(
      chipExpansion({ status: "translating", speaking: false, expanded: false, phase: p, now: NOW + PHASE_PERSIST_MS }),
    ).toBe(false);
    expect(
      chipExpansion({
        status: "translating", speaking: false, expanded: false, phase: p, now: NOW + PHASE_PERSIST_MS + 1,
      }),
    ).toBe(true);
  });

  it("ignores a phase describing a DIFFERENT status", () => {
    expect(
      chipExpansion({
        status: "injecting",
        speaking: false,
        expanded: false,
        phase: phase({ cold: true }), // kind "translating" — stale by one transition
        now: NOW + 60_000,
      }),
    ).toBe(false);
  });
});

describe("chipTuckHold", () => {
  it("only ever applies to an already-tucked chip", () => {
    expect(chipTuckHold({ peeked: false, status: "transcribing", now: NOW })).toBe(false);
  });

  it("holds the tuck through a plain finalize (the quarter-second flash)", () => {
    for (const status of PROCESSING) {
      expect(chipTuckHold({ peeked: true, status, now: NOW }), status).toBe(true);
    }
  });

  it("releases the tuck for a cold translate", () => {
    expect(
      chipTuckHold({ peeked: true, status: "translating", phase: phase({ cold: true }), now: NOW }),
    ).toBe(false);
  });

  it("releases the tuck once any phase outlasts the anti-glitch window", () => {
    const p = phase({ kind: "transcribing" });
    expect(chipTuckHold({ peeked: true, status: "transcribing", phase: p, now: NOW + 500 })).toBe(true);
    expect(chipTuckHold({ peeked: true, status: "transcribing", phase: p, now: NOW + 5_000 })).toBe(false);
  });

  it("holds when the phase is stale (kind ≠ status)", () => {
    expect(
      chipTuckHold({ peeked: true, status: "injecting", phase: phase({ cold: true }), now: NOW }),
    ).toBe(true);
  });

  // peekWhileActive ("stay hidden while dictating") is an explicit user instruction, so a
  // cold translate must NOT override it — the cancel stays reachable from Home and the
  // hotkey in that mode. The hold is only ONE term of the caller's peek eligibility; this
  // mirrors the rest of that expression (Overlay.tsx's peek driver) to pin the outcome.
  it("does not override peekWhileActive", () => {
    const eligible = (keepMin: boolean) => {
      const status: DictationStatus = "translating";
      const endFlash = chipTuckHold({ peeked: true, status, phase: phase({ cold: true }), now: NOW });
      const blocked = !keepMin && !endFlash; // speaking/processing/expanded → processing is true here
      return !blocked && (keepMin || endFlash);
    };
    expect(eligible(true)).toBe(true); // stay hidden while dictating: still tucked
    expect(eligible(false)).toBe(false); // normal mode: slides out for the wait
  });

  it("never holds a non-processing status", () => {
    expect(chipTuckHold({ peeked: true, status: "listening", phase: phase(), now: NOW })).toBe(false);
    expect(chipTuckHold({ peeked: true, status: "idle", now: NOW })).toBe(false);
  });
});

describe("chipCancelVisible", () => {
  it("is hidden when nothing is processing", () => {
    expect(chipCancelVisible({ processingSince: null, status: "listening", now: NOW })).toBe(false);
  });

  it("waits out the affordance delay for an ordinary stage", () => {
    const at = (dt: number) =>
      chipCancelVisible({ processingSince: NOW, status: "transcribing", now: NOW + dt });
    expect(at(0)).toBe(false);
    expect(at(CANCEL_AFFORDANCE_DELAY_MS - 1)).toBe(false);
    expect(at(CANCEL_AFFORDANCE_DELAY_MS)).toBe(true);
  });

  it("shows immediately for a known-cold cancellable phase", () => {
    expect(
      chipCancelVisible({
        processingSince: NOW,
        status: "translating",
        phase: phase({ cold: true, cancellable: true }),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("still waits when the phase is cold but not cancellable, or cancellable but warm", () => {
    const base = { processingSince: NOW, status: "translating" as const, now: NOW };
    expect(chipCancelVisible({ ...base, phase: phase({ cold: true }) })).toBe(false);
    expect(chipCancelVisible({ ...base, phase: phase({ cancellable: true }) })).toBe(false);
  });

  it("ignores a stale phase's early-show claim", () => {
    expect(
      chipCancelVisible({
        processingSince: NOW,
        status: "injecting",
        phase: phase({ cold: true, cancellable: true }),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("phase helpers", () => {
  it("currentPhase drops a phase that no longer matches the status", () => {
    expect(currentPhase("translating", phase())).not.toBeNull();
    expect(currentPhase("injecting", phase())).toBeNull();
    expect(currentPhase("translating", null)).toBeNull();
  });

  it("phaseElapsedMs never goes negative (clock skew between the two webviews)", () => {
    expect(phaseElapsedMs(phase(), NOW + 2_500)).toBe(2_500);
    expect(phaseElapsedMs(phase(), NOW - 5_000)).toBe(0);
    expect(phaseElapsedMs(null, NOW)).toBe(0);
  });

  it("phaseClock keeps its m:ss shape at every magnitude", () => {
    expect(phaseClock(0)).toBe("0:00");
    expect(phaseClock(9_400)).toBe("0:09");
    expect(phaseClock(59_999)).toBe("0:59");
    expect(phaseClock(62_000)).toBe("1:02");
    expect(phaseClock(3_600_000)).toBe("60:00");
  });
});
