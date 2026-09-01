import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENEW_MS, acquireWarm, preloadPlanFor, resetWarmDebounceForTests, setPreloadTransport } from "./preload";

describe("preloadPlanFor", () => {
  it("maps each rail stage onto its model family", () => {
    expect(
      preloadPlanFor({
        stages: ["downloading", "separating", "transcribing", "diarizing", "translating"],
        whisperModel: "large-v3",
        separationModel: "mdx",
        diarizationModel: "pyannote",
        translationModel: "gemma",
      }),
    ).toEqual([
      { family: "separation", id: "mdx" },
      { family: "whisper", id: "large-v3" },
      { family: "diarization", id: "pyannote" },
      { family: "translation", id: "gemma" },
    ]);
  });

  it("drops stages with no named model — the server picks its own default", () => {
    expect(preloadPlanFor({ stages: ["transcribing", "diarizing"], whisperModel: "small" })).toEqual(
      [{ family: "whisper", id: "small" }],
    );
  });

  it("has nothing to warm for a download-only rail", () => {
    expect(preloadPlanFor({ stages: ["downloading"] })).toEqual([]);
  });

  it("ignores a blank model id", () => {
    expect(preloadPlanFor({ stages: ["transcribing"], whisperModel: "   " })).toEqual([]);
  });

  it("de-duplicates a family/id pair", () => {
    expect(
      preloadPlanFor({
        stages: ["transcribing", "transcribing"],
        whisperModel: "large-v3",
      }),
    ).toEqual([{ family: "whisper", id: "large-v3" }]);
  });
});

describe("acquireWarm", () => {
  const spec = {
    serverUrl: "http://x",
    backendId: "b1",
    models: [{ family: "whisper" as const, id: "large-v3" }],
  };
  let calls: number;

  beforeEach(() => {
    vi.useFakeTimers();
    resetWarmDebounceForTests();
    calls = 0;
    setPreloadTransport(async () => {
      calls += 1;
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setPreloadTransport();
  });

  it("fires once immediately and once per renew tick", () => {
    const lease = acquireWarm("k", spec);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(RENEW_MS * 2);
    expect(calls).toBe(4);
    lease.release();
  });

  it("shares one timer between holders of the same key", () => {
    const a = acquireWarm("k", spec);
    const b = acquireWarm("k", spec);
    // The second acquire carries an identical plan inside the window, so it is
    // debounced rather than re-POSTed.
    expect(calls).toBe(1);
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(2); // one tick, not two
    a.release();
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(3); // still held by b
    b.release();
    vi.advanceTimersByTime(RENEW_MS * 3);
    expect(calls).toBe(3);
  });

  it("a re-acquire keeps the renew clock of the carried send, not its own", () => {
    // The React shape: release + re-acquire at t=RENEW_MS-1s is debounced (no POST), and the
    // renew must still land at RENEW_MS from the ORIGINAL send — a fresh interval put it at
    // ~2×RENEW_MS, past the server's plan lease.
    const a = acquireWarm("k", spec);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(RENEW_MS - 1000);
    a.release();
    const b = acquireWarm("k", spec);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(calls).toBe(2);
    // …and the steady interval continues from there.
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(3);
    b.release();
  });

  it("a release followed by a re-acquire of the same plan does not re-POST", () => {
    // The shape every React caller has: effect cleanup (release) runs before the effect
    // re-runs (acquire) on any dep change, e.g. an unrelated option click.
    const a = acquireWarm("k", spec);
    expect(calls).toBe(1);
    a.release();
    const b = acquireWarm("k", spec);
    expect(calls).toBe(1);
    b.release();
    // …but the renew window still refreshes it.
    vi.advanceTimersByTime(RENEW_MS + 1);
    const c = acquireWarm("k", spec);
    expect(calls).toBe(2);
    c.release();
  });

  it("a re-acquire after a stale carried send POSTs once, not twice", () => {
    const a = acquireWarm("k", spec);
    expect(calls).toBe(1);
    a.release();
    vi.advanceTimersByTime(RENEW_MS * 2);
    const b = acquireWarm("k", spec);
    expect(calls).toBe(2);
    // No 0 ms force-tick behind the acquire's own send; the next renew is a full window away.
    vi.advanceTimersByTime(RENEW_MS - 1);
    expect(calls).toBe(2);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(3);
    b.release();
  });

  it("stops the timer on release", () => {
    const lease = acquireWarm("k", spec);
    lease.release();
    vi.advanceTimersByTime(RENEW_MS * 5);
    expect(calls).toBe(1);
  });

  it("treats a double release as one", () => {
    const a = acquireWarm("k", spec);
    const b = acquireWarm("k", spec);
    a.release();
    a.release();
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(2); // b still holds it
    b.release();
  });

  it("re-fires when the plan actually changes", () => {
    const a = acquireWarm("k", spec);
    const b = acquireWarm("k", {
      ...spec,
      models: [{ family: "whisper" as const, id: "small" }],
    });
    expect(calls).toBe(2);
    a.release();
    b.release();
  });

  it("keeps renewing after a rejecting transport, and never throws", () => {
    setPreloadTransport(() => {
      calls += 1;
      return Promise.reject(new Error("nope"));
    });
    const lease = acquireWarm("k", spec);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(RENEW_MS * 2);
    expect(calls).toBe(3);
    lease.release();
  });

  it("sends nothing for an empty plan", () => {
    const lease = acquireWarm("k", { ...spec, models: [] });
    vi.advanceTimersByTime(RENEW_MS);
    expect(calls).toBe(0);
    lease.release();
  });
});
