// The client's copy of the server's utterance lifecycle. Each case is either the contract
// ("the server said so → act on it") or one of the two ways acting on it blindly goes wrong:
// an `open` that noise keeps alive for minutes, and a working state that flashes for a frame.
import { describe, expect, it } from "vitest";
import {
  DECODING_MAX_MS, MIN_SHOW_MS, OPEN_STALE_MS,
  display, holdRemainingMs, isLive, msUntilStale, newUtterancePending, onFrame, onSpeaking, onTerminal, reset,
} from "./utterancePending";

describe("utterancePending", () => {
  it("holds nothing until the server announces an utterance", () => {
    const p = newUtterancePending();
    expect(display(p, 0)).toBeNull();
    expect(isLive(p, 0)).toBe(false);
    expect(msUntilStale(p, 0)).toBeNull();
    expect(holdRemainingMs(p, 0)).toBe(0);
  });

  it("follows open → decoding → terminal", () => {
    const p = newUtterancePending();
    onSpeaking(p, true, 0);
    expect(onFrame(p, "open", 4, 500)).toBe(false);
    expect(display(p, 600)).toBe("open");
    onSpeaking(p, false, 2000);
    onFrame(p, "decoding", 4, 3200);
    expect(display(p, 3300)).toBe("decoding");
    onTerminal(p);
    expect(display(p, 3400)).toBeNull();
  });

  it("treats `dropped` as the terminal it is", () => {
    const p = newUtterancePending();
    onFrame(p, "open", 0, 0);
    expect(onFrame(p, "dropped", 0, 100)).toBe(true);
    expect(p.state).toBeNull();
  });

  it("ignores a state it does not know, without touching what it holds", () => {
    const p = newUtterancePending();
    onFrame(p, "decoding", 2, 0);
    expect(onFrame(p, "paused", 2, 10)).toBe(false);
    expect(display(p, 20)).toBe("decoding");
  });

  describe("open goes stale", () => {
    it("stays live for as long as the user keeps speaking", () => {
      const p = newUtterancePending();
      onSpeaking(p, true, 0);
      onFrame(p, "open", 0, 500);
      expect(isLive(p, 500 + 10 * OPEN_STALE_MS)).toBe(true);
      expect(msUntilStale(p, 5000)).toBeNull(); // nothing to wait for: the quiet edge re-arms
    });

    it("expires OPEN_STALE_MS after speech stopped — the fan that keeps the server's VAD open", () => {
      const p = newUtterancePending();
      onSpeaking(p, true, 0);
      onFrame(p, "open", 0, 500);
      onSpeaking(p, false, 2000);
      expect(msUntilStale(p, 2000)).toBe(OPEN_STALE_MS);
      expect(isLive(p, 2000 + OPEN_STALE_MS - 1)).toBe(true);
      expect(isLive(p, 2000 + OPEN_STALE_MS)).toBe(false);
      expect(display(p, 2000 + OPEN_STALE_MS)).toBeNull();
    });

    it("counts from the frame when it arrives AFTER speech stopped (a server behind realtime)", () => {
      const p = newUtterancePending();
      onSpeaking(p, true, 0);
      onSpeaking(p, false, 1000);
      onFrame(p, "open", 0, 2500);
      expect(isLive(p, 2500 + OPEN_STALE_MS - 1)).toBe(true);
      expect(isLive(p, 2500 + OPEN_STALE_MS)).toBe(false);
    });

    it("comes back to life when the user speaks again, and when the server starts decoding", () => {
      const p = newUtterancePending();
      onFrame(p, "open", 0, 0);
      expect(isLive(p, OPEN_STALE_MS + 1)).toBe(false);
      onSpeaking(p, true, OPEN_STALE_MS + 2);
      expect(isLive(p, OPEN_STALE_MS + 3)).toBe(true);
      onSpeaking(p, false, OPEN_STALE_MS + 4);
      onFrame(p, "decoding", 0, 3 * OPEN_STALE_MS);
      expect(isLive(p, 3 * OPEN_STALE_MS + 1)).toBe(true);
    });
  });

  it("believes `decoding` until its terminal, but not forever", () => {
    const p = newUtterancePending();
    onFrame(p, "decoding", 0, 1000);
    expect(msUntilStale(p, 1000)).toBe(DECODING_MAX_MS);
    expect(isLive(p, 1000 + DECODING_MAX_MS - 1)).toBe(true);
    expect(isLive(p, 1000 + DECODING_MAX_MS)).toBe(false);
  });

  it("does not restart the decoding clock when the same frame is seen twice", () => {
    const p = newUtterancePending();
    onFrame(p, "decoding", 3, 1000);
    onFrame(p, "decoding", 3, 20_000);
    expect(isLive(p, 1000 + DECODING_MAX_MS)).toBe(false);
  });

  describe("minimum show time", () => {
    it("asks for the rest of MIN_SHOW_MS when the decode was faster than the eye", () => {
      const p = newUtterancePending();
      onSpeaking(p, true, 0);
      onFrame(p, "open", 0, 500);
      onSpeaking(p, false, 2000); // blue is painted from here
      onFrame(p, "decoding", 0, 2100);
      expect(holdRemainingMs(p, 2150)).toBe(MIN_SHOW_MS - 150);
    });

    it("asks for nothing once it has been on screen long enough", () => {
      const p = newUtterancePending();
      onFrame(p, "open", 0, 0);
      onFrame(p, "decoding", 0, 1200);
      expect(holdRemainingMs(p, 1200 + MIN_SHOW_MS)).toBe(0);
    });

    it("never holds back green: while the user speaks, the working state is not on screen", () => {
      const p = newUtterancePending();
      onSpeaking(p, true, 0);
      onFrame(p, "decoding", 0, 100); // a forced commit mid-sentence
      expect(holdRemainingMs(p, 120)).toBe(0);
    });

    it("asks for nothing when the state had already gone stale", () => {
      const p = newUtterancePending();
      onFrame(p, "open", 0, 0);
      expect(holdRemainingMs(p, OPEN_STALE_MS + 50)).toBe(0);
    });
  });

  it("a new ordinal is a new utterance, even if the previous terminal never arrived", () => {
    const p = newUtterancePending();
    onFrame(p, "decoding", 1, 0);
    onFrame(p, "open", 2, 5000);
    expect(p.state).toBe("open");
    expect(p.announcedAt).toBe(5000);
  });

  it("reset forgets everything, including who was speaking", () => {
    const p = newUtterancePending();
    onSpeaking(p, true, 0);
    onFrame(p, "decoding", 9, 10);
    reset(p);
    expect(p).toEqual(newUtterancePending());
  });
});
