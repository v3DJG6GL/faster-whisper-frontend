// The capture-id pairing. Every case here is a way the previous single-slot
// "most recent id" implementation handed a phrase the wrong receipt, or none.
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { CAPTURE_ID_WAIT_MS, newCaptureIdBook } from "./captureIds";

describe("newCaptureIdBook", () => {
  it("hands each utterance ITS OWN id", async () => {
    const b = newCaptureIdBook();
    b.resolve(0, "cap-a");
    b.resolve(1, "cap-b");
    expect(await b.take(1)).toBe("cap-b");
    expect(await b.take(0)).toBe("cap-a");
  });

  it("an utterance with no capture row does not steal the next one's id", async () => {
    // The server samples captures and caps them by count/bytes/duration/disk,
    // so utterance 1 here simply never produced one. The old positional slot
    // gave phrase 1 the id belonging to utterance 2.
    const b = newCaptureIdBook({ waitMs: 5 });
    b.resolve(0, "cap-0");
    b.resolve(2, "cap-2");
    expect(await b.take(0)).toBe("cap-0");
    expect(await b.take(1)).toBeNull();
    expect(await b.take(2)).toBe("cap-2");
  });

  it("an id is handed out exactly once", async () => {
    const b = newCaptureIdBook({ waitMs: 5 });
    b.resolve(3, "cap-3");
    expect(await b.take(3)).toBe("cap-3");
    expect(await b.take(3)).toBeNull();
  });

  it("the one-shot claims nothing", async () => {
    const b = newCaptureIdBook();
    b.resolve(0, "cap-0");
    expect(await b.take(null)).toBeNull();
    // …and the id it did not take is still there for the phrase that owns it.
    expect(await b.take(0)).toBe("cap-0");
  });

  it("empty ids are ignored rather than parked", async () => {
    const b = newCaptureIdBook({ waitMs: 5 });
    b.resolve(0, "");
    expect(await b.take(0)).toBeNull();
  });

  describe("when the frame is still in flight", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits for an id that arrives after the phrase asked", async () => {
      const b = newCaptureIdBook();
      const p = b.take(0);
      await vi.advanceTimersByTimeAsync(CAPTURE_ID_WAIT_MS / 2);
      b.resolve(0, "late");
      expect(await p).toBe("late");
    });

    it("gives up after the wait rather than blocking the inject queue", async () => {
      const b = newCaptureIdBook();
      const p = b.take(0);
      await vi.advanceTimersByTimeAsync(CAPTURE_ID_WAIT_MS + 1);
      expect(await p).toBeNull();
    });

    it("an id arriving AFTER the giving-up is not handed to a later phrase", async () => {
      const b = newCaptureIdBook();
      const p = b.take(0);
      await vi.advanceTimersByTimeAsync(CAPTURE_ID_WAIT_MS + 1);
      expect(await p).toBeNull();
      b.resolve(0, "very-late");
      // It belongs to utterance 0 and to nothing else — utterance 1 must not
      // inherit it, which is exactly what the single slot used to do.
      const other = b.take(1);
      await vi.advanceTimersByTimeAsync(CAPTURE_ID_WAIT_MS + 1);
      expect(await other).toBeNull();
    });

    it("reset unparks a waiting phrase instead of leaving it hanging", async () => {
      const b = newCaptureIdBook();
      const p = b.take(0);
      b.reset();
      expect(await p).toBeNull();
    });

    it("reset drops ids the next session must never see", async () => {
      const b = newCaptureIdBook();
      b.resolve(0, "old-session");
      b.reset();
      const p = b.take(0);
      await vi.advanceTimersByTimeAsync(CAPTURE_ID_WAIT_MS + 1);
      expect(await p).toBeNull();
    });
  });
});
