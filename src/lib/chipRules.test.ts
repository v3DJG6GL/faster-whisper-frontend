// The chip's expand / tuck / cancel decisions, kept pure (outside Overlay.tsx) because
// there is no jsdom here — these matrices are their behavioural coverage.

import { describe, expect, it } from "vitest";
import {
  CANCEL_AFFORDANCE_DELAY_MS, PHASE_PERSIST_MS, chipCancelVisible, chipExpansion, chipLabelHoldOpens, chipTuckHold,
  currentPhase, nextProcessingSince, phaseClock, phaseElapsedMs, stepProcessingStamp, type ProcessingStamp,
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

  it("keeps an open pill open while the server holds or decodes the phrase, but never pops one", () => {
    for (const serverWork of ["open", "decoding"] as const) {
      // Sustains: the pill is where "transcribing…" is read, and closing it the instant the
      // user pauses only to reopen it for the inserted text is the flicker this avoids.
      expect(
        chipExpansion({ status: "listening", speaking: false, expanded: true, serverWork, now: NOW }),
        serverWork,
      ).toBe(true);
      // Never initiates — same rule as every processing state: the tucked dot turns blue instead.
      expect(
        chipExpansion({ status: "listening", speaking: false, expanded: false, serverWork, now: NOW }),
        serverWork,
      ).toBe(false);
    }
  });

  it("expands for a cold model load, like warm-up: a wait worth naming", () => {
    expect(
      chipExpansion({ status: "listening", speaking: false, expanded: false, serverWork: "loading", now: NOW }),
    ).toBe(true);
    // …but only behind a listening status: a stale value must not open an idle chip.
    expect(
      chipExpansion({ status: "idle", speaking: false, expanded: false, serverWork: "loading", now: NOW }),
    ).toBe(false);
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

  // The hold is only ONE term of the caller's peek eligibility; this mirrors the rest of that
  // expression (Overlay.tsx's peek driver) to pin the outcome.
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

describe("chipLabelHoldOpens", () => {
  it("opens a collapsed chip while an end-of-session label's hold is up", () => {
    // The pill collapsed when the user went quiet, then the translate failed fast at idle: the
    // 2.6 s reason must still open it rather than pulse as a bare dot.
    expect(chipExpansion({ status: "idle", speaking: false, expanded: false, now: NOW })).toBe(false);
    expect(chipLabelHoldOpens({ holdUntil: NOW + 2600, peeked: false, now: NOW })).toBe(true);
  });

  it("does not open once the hold has run out, or with none stamped", () => {
    expect(chipLabelHoldOpens({ holdUntil: NOW + 2600, peeked: false, now: NOW + 2600 })).toBe(false);
    expect(chipLabelHoldOpens({ holdUntil: 0, peeked: false, now: NOW })).toBe(false);
  });

  it("leaves a chip tucked at the edge tucked", () => {
    expect(chipLabelHoldOpens({ holdUntil: NOW + 2600, peeked: true, now: NOW })).toBe(false);
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

  it("offers no session cancel during a live per-phrase translate (the mic is still capturing)", () => {
    // A live phrase's translate has no phase card, so the ✕ would be cancel-dictation and
    // discard the session the user is still speaking into — a STOP state, not a cancel.
    const long = { processingSince: NOW, status: "translating" as const, phase: null, now: NOW + 5_000 };
    expect(chipCancelVisible({ ...long, capturing: true })).toBe(false);
    for (const status of PROCESSING) {
      expect(chipCancelVisible({ ...long, status, capturing: true })).toBe(false);
    }
    // Post-capture, the same stall keeps its recovery ✕.
    expect(chipCancelVisible({ ...long, capturing: false })).toBe(true);
    expect(chipCancelVisible(long)).toBe(true);
  });

  it("keeps the cancel-translate ✕ of a cancellable translate card while capturing", () => {
    const base = { processingSince: NOW, status: "translating" as const, capturing: true };
    expect(chipCancelVisible({ ...base, phase: phase({ cold: true, cancellable: true }), now: NOW })).toBe(true);
    expect(
      chipCancelVisible({ ...base, phase: phase({ cancellable: true }), now: NOW + CANCEL_AFFORDANCE_DELAY_MS }),
    ).toBe(true);
    // Not cancellable → its ✕ would be the session cancel again.
    expect(chipCancelVisible({ ...base, phase: phase(), now: NOW + 5_000 })).toBe(false);
  });
});

describe("nextProcessingSince", () => {
  const live = { processing: true, capturing: true };
  const post = { processing: true, capturing: false };
  const off = { processing: false, capturing: false };

  it("stamps a run when it starts and clears it when it ends", () => {
    expect(nextProcessingSince(null, off, post, NOW)).toBe(NOW);
    expect(nextProcessingSince(NOW, post, off, NOW + 50)).toBeNull();
  });

  it("restamps when the mic closes mid-run, so the ✕ waits its delay from the stop", () => {
    // A live per-phrase translate began 5 s before the stop; the stop flows straight into
    // finalizing without `processing` ever dropping.
    const since = nextProcessingSince(NOW - 5_000, live, post, NOW);
    expect(since).toBe(NOW);
    const show = (dt: number) =>
      chipCancelVisible({ processingSince: since, status: "transcribing", capturing: false, now: NOW + dt });
    expect(show(0)).toBe(false);
    expect(show(CANCEL_AFFORDANCE_DELAY_MS)).toBe(true);
  });

  it("keeps the stamp across an unrelated re-render of the same run", () => {
    expect(nextProcessingSince(NOW - 5_000, post, post, NOW)).toBe(NOW - 5_000);
    expect(nextProcessingSince(NOW - 5_000, live, live, NOW)).toBe(NOW - 5_000);
  });

  it("a cold cancellable translate card while capturing still gets a stamp (its immediate ✕)", () => {
    const since = nextProcessingSince(null, { processing: false, capturing: true }, live, NOW);
    expect(
      chipCancelVisible({
        processingSince: since,
        status: "translating",
        phase: phase({ cold: true, cancellable: true }),
        capturing: true,
        now: NOW,
      }),
    ).toBe(true);
  });
});

// Overlay steps the stamp during render, so the rule never sees a new `capturing` beside the old
// stamp. Replays the chip's renders: on the one where the mic closes mid-translate, the ✕ (which
// a passive-effect restamp drew for one painted frame) must already be hidden.
describe("stepProcessingStamp", () => {
  function render(stamp: ProcessingStamp, payload: { status: DictationStatus; capturing: boolean }, now: number) {
    const next = stepProcessingStamp(stamp, { processing: PROCESSING.includes(payload.status), capturing: payload.capturing }, now);
    const cancel = chipCancelVisible({ processingSince: next.since, status: payload.status, capturing: payload.capturing, now });
    return { stamp: next, cancel };
  }

  it("hides the ✕ on the very render the mic closes during a long translate", () => {
    let r = render({ processing: false, capturing: false, since: null }, { status: "listening", capturing: true }, NOW - 6_000);
    r = render(r.stamp, { status: "translating", capturing: true }, NOW - 5_000);
    expect(r.cancel).toBe(false); // capturing: a stop, not a cancel
    r = render(r.stamp, { status: "translating", capturing: false }, NOW);
    expect(r.stamp.since).toBe(NOW);
    expect(r.cancel).toBe(false);
    expect(render(r.stamp, { status: "translating", capturing: false }, NOW + CANCEL_AFFORDANCE_DELAY_MS).cancel).toBe(true);
  });

  it("returns the same stamp when nothing it depends on changed", () => {
    const stamp: ProcessingStamp = { processing: true, capturing: false, since: NOW - 5_000 };
    expect(stepProcessingStamp(stamp, { processing: true, capturing: false }, NOW)).toBe(stamp);
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
