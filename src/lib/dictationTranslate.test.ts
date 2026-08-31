// The dictation translate seam: the cold-aware budget table, and the rule that
// a race WE abandon is the only one that owes the server a cancel. Transport is
// injected as parameters (nothing here mocks Tauri).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLD_LIVE_MS, COLD_ONESHOT_MS, newAbortHandle, runDictationTranslate,
  translateBudgetMs, type DictationTranslateRequest, type TranslateDeps,
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

describe("translateBudgetMs", () => {
  it("warm keeps today's length formula (2 s floor, 60 s ceiling)", () => {
    const warm = { warm: true as const, oneShot: false, queued: 0 };
    expect(translateBudgetMs(0, warm)).toBe(2_000);
    expect(translateBudgetMs(73, warm)).toBe(3_325);
    expect(translateBudgetMs(100_000, warm)).toBe(60_000);
    // …and the one-shot/backlog knobs never lengthen a WARM budget.
    expect(translateBudgetMs(73, { ...warm, oneShot: true })).toBe(3_325);
  });

  it("a cold stop-timing one-shot gets the full 60 s (the GGUF load)", () => {
    expect(translateBudgetMs(73, { warm: false, oneShot: true, queued: 0 })).toBe(COLD_ONESHOT_MS);
    // warm === null (older backend, no probe) is treated as cold.
    expect(translateBudgetMs(73, { warm: null, oneShot: true, queued: 0 })).toBe(COLD_ONESHOT_MS);
  });

  it("a cold live phrase gets 20 s while nothing is queued behind it", () => {
    expect(translateBudgetMs(73, { warm: false, oneShot: false, queued: 0 })).toBe(COLD_LIVE_MS);
    expect(translateBudgetMs(73, { warm: null, oneShot: false, queued: 1 })).toBe(COLD_LIVE_MS);
  });

  it("a backlog degrades to the warm formula rather than stalling the queue", () => {
    expect(translateBudgetMs(73, { warm: false, oneShot: false, queued: 2 })).toBe(3_325);
    expect(translateBudgetMs(0, { warm: null, oneShot: false, queued: 9 })).toBe(2_000);
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

    it("timeout returns the ORIGINAL and cancels the minted progress id once", async () => {
      const d = deps(() => new Promise<TextTranslationResult>(() => {}));
      const p = runDictationTranslate(req({ text: "Hallo", oneShot: true }), d);
      await vi.advanceTimersByTimeAsync(COLD_ONESHOT_MS - 1);
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

    it("a translation that lands inside the budget never cancels", async () => {
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
      await vi.advanceTimersByTimeAsync(COLD_ONESHOT_MS);
      expect(d.cancel).not.toHaveBeenCalled();
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
    expect(seen).toEqual([{ progressId: PID, budgetMs: 2_000, cold: false }]);
  });
});
