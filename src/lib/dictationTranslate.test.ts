// The dictation translate seam: how long a phrase may wait (a ceiling on
// LATENESS, plus a stall detector that watches the server's progress entry),
// and the rule that a race WE abandon is the only one that owes the server a
// cancel. Transport is injected as parameters (nothing here mocks Tauri).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CEILING_FLOOR_LIVE_MS, CEILING_FLOOR_ONESHOT_MS, STALL_COLD_MS, STALL_WARM_MS,
  newAbortHandle, pricedMs, runDictationTranslate, translateCeilingMs, translateStallMs,
  type DictationTranslateRequest, type TranslateDeps,
} from "./dictationTranslate";
import type { TextTranslationResult } from "./api";

const PID = "deadbeefcafe";

const req = (
  over: Partial<DictationTranslateRequest> = {},
): DictationTranslateRequest => ({
  text: "Hallo Welt",
  context: [],
  targets: ["en"],
  serverUrl: "http://s",
  backendId: "b1",
  warm: null,
  oneShot: false,
  queued: 0,
  ...over,
});

const answer = (texts: string[], langs = ["en"]): TextTranslationResult => ({
  results: texts.map((t) => Object.fromEntries(langs.map((l) => [l, `${l}:${t}`]))),
});

const deps = (translate: TranslateDeps["translate"]) => ({
  translate,
  cancel: vi.fn((_a: { serverUrl: string; backendId: string; progressId: string }) => {}),
  newId: () => PID,
});

describe("pricedMs", () => {
  // Regression guard for the bug this module existed to hide: the old formula
  // was `1500 + phraseChars * 25`, priced for ONE pass over the phrase alone,
  // while the server translates every submitted segment for every target. A
  // 4-word phrase with 2 targets got 1.95 s for 2.4 s of real work and lost
  // the race deterministically — the shorter the phrase, the surer the loss.
  it("scales with the target count, not just the text", () => {
    expect(pricedMs(100, 1)).toBe(900);
    expect(pricedMs(100, 2)).toBe(1_800);
    expect(pricedMs(100, 4)).toBe(3_600);
  });

  it("matches the observed runs it was fitted to (within 30 %)", () => {
    // From a real EN+FR dictation session: chars submitted → wall seconds.
    for (const [chars, actualMs] of [[174, 2_200], [221, 3_100], [193, 2_400]]) {
      const predicted = pricedMs(chars, 2);
      expect(Math.abs(predicted - actualMs) / actualMs).toBeLessThan(0.3);
    }
  });

  it("a zero target list still costs one pass, never zero", () => {
    expect(pricedMs(100, 0)).toBe(900);
  });
});

describe("translateCeilingMs", () => {
  it("a live phrase never waits less than the 20 s floor", () => {
    expect(translateCeilingMs(10, 1, { oneShot: false, queued: 0 })).toBe(CEILING_FLOOR_LIVE_MS);
  });

  it("a one-shot never waits less than the 60 s floor (the GGUF load)", () => {
    expect(translateCeilingMs(10, 1, { oneShot: true, queued: 0 })).toBe(CEILING_FLOOR_ONESHOT_MS);
  });

  it("a big payload lifts the ceiling above the floor", () => {
    // 4 000 chars × 2 targets → priced 40.8 s → ×3 slack = 122.4 s.
    expect(translateCeilingMs(4_000, 2, { oneShot: false, queued: 0 })).toBe(122_400);
  });

  it("a backlog halves the slack — later phrases are waiting on this one", () => {
    const alone = translateCeilingMs(4_000, 2, { oneShot: false, queued: 0 });
    const behind = translateCeilingMs(4_000, 2, { oneShot: false, queued: 1 });
    expect(behind).toBe(61_200);
    expect(behind).toBeLessThan(alone);
  });

  it("queued === 1 already counts as a backlog", () => {
    // The depth is read BEFORE this phrase's own increment, so 1 means one
    // task ahead of us. The old `queued > 1` made the branch unreachable.
    expect(translateCeilingMs(4_000, 2, { oneShot: false, queued: 1 })).toBeLessThan(
      translateCeilingMs(4_000, 2, { oneShot: false, queued: 0 }),
    );
  });

  it("is bounded — no phrase waits five minutes", () => {
    expect(translateCeilingMs(10_000_000, 8, { oneShot: true, queued: 0 })).toBe(300_000);
  });
});

describe("translateStallMs", () => {
  it("tolerates a long silence until the session has seen a translation land", () => {
    // A cold GGUF load produces no measurable progress for tens of seconds;
    // treating that as a hang is the mistake the old budget made.
    expect(translateStallMs(null)).toBe(STALL_COLD_MS);
    expect(translateStallMs(false)).toBe(STALL_COLD_MS);
  });

  it("is impatient once the model is known resident", () => {
    expect(translateStallMs(true)).toBe(STALL_WARM_MS);
  });
});

describe("runDictationTranslate", () => {
  it("sends context + text and consumes only the LAST result map", async () => {
    const seen: string[][] = [];
    const d = deps((a) => {
      seen.push(a.texts);
      expect(a.progressId).toBe(PID);
      expect(a.contextSegments).toBe(2);
      return Promise.resolve(answer(a.texts));
    });
    const r = await runDictationTranslate(
      req({ text: "drei", context: ["eins", "zwei"] }),
      d,
    );
    expect(seen).toEqual([["eins", "zwei", "drei"]]);
    // byLang carries the same translations still keyed by language: `text` is
    // the injected join and cannot be split back apart, so this map is the
    // only way History can render one track per language.
    expect(r).toEqual({ text: "en:drei", ok: true, byLang: { en: "en:drei" } });
    expect(d.cancel).not.toHaveBeenCalled();
  });

  it("forwards the capture id so the server can complete its held receipt", async () => {
    let seen: unknown;
    const d = deps((a) => {
      seen = (a as { capturedId?: string | null }).capturedId;
      return Promise.resolve(answer(a.texts));
    });
    await runDictationTranslate(req({ capturedId: "caac29d3" }), d);
    expect(seen).toBe("caac29d3");
  });

  it("sends null when there is no held receipt", async () => {
    // Every non-dictation caller, and any dictation against a backend too old
    // to send the id. The server treats it as "nothing held", not an error.
    let seen: unknown = "unset";
    const d = deps((a) => {
      seen = (a as { capturedId?: string | null }).capturedId;
      return Promise.resolve(answer(a.texts));
    });
    await runDictationTranslate(req({}), d);
    expect(seen).toBeNull();
  });

  it("joins every target with a blank line, original first when asked", async () => {
    const d = deps((a) => Promise.resolve(answer(a.texts, ["en", "fr"])));
    const r = await runDictationTranslate(
      req({ text: "hi", targets: ["en", "fr"], includeOriginal: true }),
      d,
    );
    expect(r.text).toBe("hi\n\nen:hi\n\nfr:hi");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("the ceiling returns the ORIGINAL and cancels the minted progress id once", async () => {
      const d = deps(() => new Promise<TextTranslationResult>(() => {}));
      const p = runDictationTranslate(req({ text: "Hallo", oneShot: true }), d);
      await vi.advanceTimersByTimeAsync(CEILING_FLOOR_ONESHOT_MS - 1);
      expect(d.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      const r = await p;
      expect(r).toMatchObject({ text: "Hallo", ok: false, cause: "timeout" });
      expect(d.cancel).toHaveBeenCalledTimes(1);
      expect(d.cancel).toHaveBeenCalledWith({
        serverUrl: "http://s",
        backendId: "b1",
        progressId: PID,
      });
    });

    it("a translation that lands inside the ceiling never cancels", async () => {
      const d = deps(
        (a) =>
          new Promise<TextTranslationResult>((res) =>
            setTimeout(() => res(answer(a.texts)), 5_000),
          ),
      );
      const p = runDictationTranslate(req({ oneShot: true }), d);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toEqual({
        text: "en:Hallo Welt", ok: true, byLang: { en: "en:Hallo Welt" },
      });
      await vi.advanceTimersByTimeAsync(CEILING_FLOOR_ONESHOT_MS);
      expect(d.cancel).not.toHaveBeenCalled();
    });

    it("a server that keeps REPORTING PROGRESS outlives the priced budget", async () => {
      // The whole point of the stall detector: this run takes 40 s, far past
      // anything the old length formula would have allowed, but the progress
      // entry advances every poll so it is never abandoned.
      let pct = 0;
      const d = {
        ...deps(
          (a) =>
            new Promise<TextTranslationResult>((res) =>
              setTimeout(() => res(answer(a.texts)), 40_000),
            ),
        ),
        pollProgress: async () => ({ stage: "translating", progress: (pct += 0.01) }),
      };
      const p = runDictationTranslate(req({ warm: true, oneShot: true }), d);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await p).toMatchObject({ ok: true });
      expect(d.cancel).not.toHaveBeenCalled();
    });

    it("a server that goes SILENT is abandoned at the stall threshold", async () => {
      const d = {
        ...deps(() => new Promise<TextTranslationResult>(() => {})),
        // Same reading forever = wedged.
        pollProgress: async () => ({ stage: "translating", progress: 0.5 }),
      };
      const p = runDictationTranslate(req({ text: "Hallo", warm: true, oneShot: true }), d);
      await vi.advanceTimersByTimeAsync(STALL_WARM_MS - 1_000);
      expect(d.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      const r = await p;
      expect(r).toMatchObject({ text: "Hallo", ok: false, cause: "timeout" });
      expect(String(r.error)).toContain("no progress");
      expect(d.cancel).toHaveBeenCalledTimes(1);
    });

    it("a progress endpoint that ERRORS is not a stall — the ceiling still applies", async () => {
      const d = {
        ...deps(() => new Promise<TextTranslationResult>(() => {})),
        pollProgress: async () => {
          throw new Error("404");
        },
      };
      const p = runDictationTranslate(req({ text: "Hallo", warm: true, oneShot: false }), d);
      await vi.advanceTimersByTimeAsync(STALL_WARM_MS * 2);
      expect(d.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CEILING_FLOOR_LIVE_MS);
      const r = await p;
      expect(r).toMatchObject({ text: "Hallo", ok: false, cause: "timeout" });
      expect(String(r.error)).toContain("no answer within");
    });

    it("polls the progress id it minted, and stops polling once settled", async () => {
      const seen: string[] = [];
      const d = {
        ...deps(
          (a) =>
            new Promise<TextTranslationResult>((res) =>
              setTimeout(() => res(answer(a.texts)), 3_000),
            ),
        ),
        pollProgress: async (a: { progressId: string }) => {
          seen.push(a.progressId);
          return { stage: "translating", progress: seen.length / 100 };
        },
      };
      const p = runDictationTranslate(req({ warm: true }), d);
      await vi.advanceTimersByTimeAsync(3_000);
      await p;
      const afterSettle = seen.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(seen.length).toBe(afterSettle);
      expect(new Set(seen)).toEqual(new Set([PID]));
    });
  });

  it("abort resolves with the original IMMEDIATELY and cancels server-side", async () => {
    const d = deps(() => new Promise<TextTranslationResult>(() => {}));
    const abort = newAbortHandle();
    const p = runDictationTranslate(req({ text: "Hallo", abort }), d);
    abort.abort();
    expect(await p).toMatchObject({ text: "Hallo", ok: false, cause: "cancelled" });
    expect(d.cancel).toHaveBeenCalledTimes(1);
    expect(d.cancel).toHaveBeenCalledWith({
      serverUrl: "http://s",
      backendId: "b1",
      progressId: PID,
    });
  });

  it("an already-tripped handle short-circuits before the budget", async () => {
    const abort = newAbortHandle();
    abort.abort();
    const d = deps(() => new Promise<TextTranslationResult>(() => {}));
    expect(await runDictationTranslate(req({ abort }), d)).toMatchObject({ cause: "cancelled" });
    expect(d.cancel).toHaveBeenCalledTimes(1);
  });

  it("empty results fall back to the original and cancel NOTHING", async () => {
    const d = deps((a) => Promise.resolve({ results: a.texts.map(() => ({})) }));
    const r = await runDictationTranslate(req({ text: "Hallo" }), d);
    expect(r).toMatchObject({ text: "Hallo", ok: false, cause: "empty" });
    expect(d.cancel).not.toHaveBeenCalled();
  });

  it("a target missing from the answer is dropped, not rendered blank", async () => {
    const d = deps((a) => Promise.resolve(answer(a.texts, ["en"])));
    const r = await runDictationTranslate(req({ targets: ["en", "fr"] }), d);
    // Dropped from BOTH views, not blank in one of them — the parts array is
    // derived from byLang, so the join and the map cannot disagree about
    // which targets actually came back.
    expect(r).toEqual({
      text: "en:Hallo Welt", ok: true, byLang: { en: "en:Hallo Welt" },
    });
  });

  it("a rejecting request is an error, and the request already ended → no cancel", async () => {
    const d = deps(() => Promise.reject(new Error("HTTP 403: translation disabled")));
    const r = await runDictationTranslate(req({ text: "Hallo" }), d);
    expect(r).toMatchObject({ text: "Hallo", ok: false, cause: "error" });
    expect(String(r.error)).toContain("HTTP 403");
    expect(d.cancel).not.toHaveBeenCalled();
  });

  it("onStart hands the caller the id and budget before the request goes out", async () => {
    const seen: unknown[] = [];
    const d = deps((a) => Promise.resolve(answer(a.texts)));
    await runDictationTranslate(
      req({ text: "x", warm: true, onStart: (i) => seen.push(i) }),
      d,
    );
    expect(seen).toEqual([
      { progressId: PID, ceilingMs: CEILING_FLOOR_LIVE_MS, stallMs: STALL_WARM_MS, cold: false },
    ]);
  });
});
