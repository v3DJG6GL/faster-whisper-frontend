// The dictation translate call, extracted from streaming.ts so it can be
// TESTED. Nothing in this repo mocks Tauri (`isTauri` is false under vitest and
// `vi.mock` is used nowhere), so the transport reaches this module as injected
// parameters — the same idiom runChunkedTranslate uses.
//
// Three bugs live here, and all three are why the seam exists:
//   • The budget was derived from the TEXT LENGTH alone, so a 73-character
//     sentence got 3.3 s while a cold llama.cpp server needed 13 s (12.3 s of
//     it a GGUF load). Every first phrase of a session lost that race and
//     "translation timed out" was reported for work that was progressing fine.
//   • Losing the race cancelled NOTHING: no progressId was ever sent, so the
//     request kept running against Rust's 3600 s TEXT_TRANSLATE_TIMEOUT and the
//     GPU finished a translation nobody would read.
//   • The length formula itself was priced for the wrong job. The request
//     submits `[...context, phrase]` and the server translates ALL of it for
//     EVERY target — a live phrase with 3 context segments and 2 targets is
//     six passes — while the budget paid for one pass over the phrase alone.
//     The shorter the phrase the worse the underpricing, so a 4-word phrase
//     ("Ich weiss es nicht") was given 1.95 s for 2.4 s of work and lost the
//     race EVERY time, deterministically. Elapsed time is now a ceiling only;
//     the real signal is whether the server's progress entry is still moving.
import type { TextTranslationResult } from "./api";
import type { BatchProgress } from "./types";

/** The translation mode a dictation request must use.
 *
 *  A LIVE phrase is always faithful, whatever the profile asks for. Live sends
 *  `[...context, phrase]` and consumes ONLY THE LAST result; fluent is sentence-MERGED, so
 *  the server may fold the phrase's opening clause into the preceding context segment —
 *  which is then discarded, and the user gets a beheaded translation. It bites per target,
 *  so one language can arrive whole while another is truncated from the same request.
 *
 *  The one-shot path keeps the profile's choice: it translates the whole transcript in one
 *  call and consumes every segment, so merging is a benefit there rather than a hazard. */
export function translateModeFor(
  oneShot: boolean,
  configured: "fluent" | "faithful" | undefined,
): "fluent" | "faithful" | undefined {
  return oneShot ? configured : "faithful";
}

/** Why the translation didn't land. Recorded per session so the failure
 *  doorway can name the cause instead of blaming the server for a race we
 *  lost. */
export type TranslateFailure = "timeout" | "cancelled" | "error" | "empty";

export interface TranslateDeps {
  translate: (args: {
    serverUrl: string;
    backendId: string;
    texts: string[];
    targets: string[];
    /** The spoken language; null = let the server detect it. */
    source?: string | null;
    model?: string;
    mode?: "fluent" | "faithful";
    glossary?: string;
    contextSegments?: number | null;
    progressId?: string | null;
    capturedId?: string | null;
  }) => Promise<TextTranslationResult>;
  /** Best-effort server-side abort. Called ONLY when we stopped waiting. */
  cancel: (args: { serverUrl: string; backendId: string; progressId: string }) => unknown;
  /** The server's progress entry for `progressId`. This is what makes the
   *  stall detector possible — without it there is nothing to distinguish a
   *  wedged server from a slow one, and only the ceiling applies. Absent under
   *  vitest (nothing mocks Tauri) and on a backend with no progress endpoint. */
  pollProgress?: (args: {
    serverUrl: string;
    backendId: string;
    progressId: string;
  }) => Promise<BatchProgress | null>;
  /** How often to poll. Kept injectable so the tests don't have to model the
   *  real cadence. */
  pollMs?: number;
  now?: () => number;
  newId?: () => string;
}

/** A one-way "stop waiting" latch. Not an AbortController: the Rust side has no
 *  signal to forward it to — the abort resolves OUR promise early and the
 *  server is stopped by the progress-id cancel instead. */
export interface AbortHandle {
  aborted: boolean;
  onAbort(cb: () => void): void;
}

export interface DictationTranslateRequest {
  text: string;
  /** Prior ORIGINAL phrases, sent as leading context segments. */
  context: string[];
  targets: string[];
  /** The session's resolved source language (null/absent = auto-detect). */
  source?: string | null;
  includeOriginal?: boolean;
  model?: string;
  glossary?: string;
  mode?: "fluent" | "faithful";
  contextSegments?: number;
  serverUrl: string;
  backendId: string;
  /** The capture whose server-side log receipt is waiting on this call. */
  capturedId?: string | null;
  /** Has this server already produced a translation this session? `null` =
   *  unknown (older backend / no capability probe yet) — treated as cold. */
  warm: boolean | null;
  /** The stop-timing single insert: the LAST task in the inject chain, so a
   *  long wait here blocks nothing. */
  oneShot: boolean;
  /** Inject-queue depth read SYNCHRONOUSLY at enqueue time (see the budget
   *  table). */
  queued: number;
  abort?: AbortHandle;
  /** Fires once the progress id exists, before the request goes out — the
   *  caller uses it to arm the cancel handle and, on a cold one-shot, the
   *  progress phase card. */
  onStart?: (info: {
    progressId: string;
    ceilingMs: number;
    stallMs: number;
    cold: boolean;
  }) => void;
  /** Every progress reading the stall detector takes, handed on so the caller
   *  can drive its phase card from the SAME poll instead of running a second
   *  interval against the same endpoint. */
  onProgress?: (p: BatchProgress) => void;
}

export interface DictationTranslateResult {
  /** The translation, or the ORIGINAL text on any failure — the user's words
   *  must still land. */
  text: string;
  ok: boolean;
  cause?: TranslateFailure;
  /** The raw failure, for the doorway's `shortCause`. */
  error?: unknown;
  /** The same translations, still keyed by language.
   *
   *  `text` above is what gets INJECTED, so it must stay a single joined
   *  string — but the join is lossy: blocks are separated by a blank line
   *  and a transcript contains its own line breaks, so nothing downstream
   *  can split it back apart. This function is the only place the
   *  language→text association ever exists, so anything that wants to show
   *  the tracks separately (History, the log receipt) has to be handed the
   *  map from here. Absent on the failure paths, where `text` is the
   *  untranslated original. */
  byLang?: Record<string, string>;
}

/** What the submitted payload should cost, measured on the reference
 *  deployment (HY-MT1.5-7B Q4_K_M, warm, CUDA llama.cpp): roughly 0.4 s of
 *  fixed overhead plus 5 ms per source character, PER TARGET.
 *
 *      174 chars → 2 targets → 2.5 s predicted / 2.2 s actual
 *      221 chars → 2 targets → 3.0 s predicted / 3.1 s actual
 *      193 chars → 2 targets → 2.7 s predicted / 2.4 s actual
 *
 *  `chars` is every character SUBMITTED — the context segments as well as the
 *  phrase — because the server translates all of them (its own log says
 *  `3 segments × 2 targets`). Pricing the phrase alone, once, is what made
 *  short multi-target phrases fail deterministically. */
export function pricedMs(chars: number, targets: number): number {
  return Math.max(1, targets) * (400 + chars * 5);
}

/** The point past which a phrase is worth less than the original text landing
 *  now. NOT a prediction of how long the work takes — the stall detector owns
 *  that — just a bound on how late an answer may be and still be useful.
 *
 *  | case                        | ceiling                          |
 *  | live phrase                 | max(20 s, priced × 3)            |
 *  | live phrase, backlog behind | max(20 s, priced × 1.5)          |
 *  | oneShot (stop-timing)       | max(60 s, priced × 3)            |
 *
 *  WHY the live floor is 20 s and not the one-shot's 60 s: a phrase landing a
 *  minute after it was spoken, while the user has kept talking, is WORSE than
 *  the original landing now. And why a backlog is less patient: a queue means
 *  later phrases are already waiting on this one — stalling it stalls them
 *  all, so take the original and keep the typing current.
 *
 *  `queued >= 1`, not `> 1`: the depth is read BEFORE this phrase's own
 *  increment, so `1` already means one task ahead of us. The old `> 1` made
 *  the whole branch unreachable in live dictation — it never fired once. */
export const CEILING_FLOOR_ONESHOT_MS = 60_000;
export const CEILING_FLOOR_LIVE_MS = 20_000;
export const CEILING_MAX_MS = 300_000;
export function translateCeilingMs(
  chars: number,
  targets: number,
  o: { oneShot: boolean; queued: number },
): number {
  const floor = o.oneShot ? CEILING_FLOOR_ONESHOT_MS : CEILING_FLOOR_LIVE_MS;
  const slack = o.queued >= 1 ? 1.5 : 3;
  return Math.min(CEILING_MAX_MS, Math.max(floor, Math.round(pricedMs(chars, targets) * slack)));
}

/** How long the server may go SILENT before we give up on it.
 *
 *  A cold start is the reason there are two values: downloading and loading a
 *  GGUF produces no measurable progress for tens of seconds, and treating that
 *  silence as a hang is precisely the mistake the old budget made. Once the
 *  session has seen one translation land, the model is resident and a long
 *  silence really is a wedge. */
export const STALL_WARM_MS = 8_000;
export const STALL_COLD_MS = 45_000;
export function translateStallMs(warm: boolean | null): number {
  return warm === true ? STALL_WARM_MS : STALL_COLD_MS;
}

/** Distinguishable rejections: the `finally` must cancel server-side for a race
 *  WE lost (timeout/abort) and must NOT for one that already ended (a rejected
 *  request, an empty answer). */
class BudgetExpired extends Error {}
class Aborted extends Error {}
class EmptyTranslation extends Error {}

/** A latch usable as `AbortHandle`, plus the trip. */
export function newAbortHandle(): AbortHandle & { abort(): void } {
  const cbs: Array<() => void> = [];
  const h: AbortHandle & { abort(): void } = {
    aborted: false,
    onAbort(cb) {
      if (h.aborted) cb();
      else cbs.push(cb);
    },
    abort() {
      if (h.aborted) return;
      h.aborted = true;
      for (const cb of cbs.splice(0)) cb();
    },
  };
  return h;
}

function defaultId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Translate one dictation payload, or give the ORIGINAL text back. Never
 *  throws — every failure is a `cause` the caller reports once per session. */
export async function runDictationTranslate(
  req: DictationTranslateRequest,
  deps: TranslateDeps,
): Promise<DictationTranslateResult> {
  const original = req.text;
  const progressId = (deps.newId ?? defaultId)();
  // Every character the server will actually translate, not just this phrase's.
  const submittedChars =
    req.context.reduce((n, c) => n + c.length, 0) + original.length;
  const ceilingMs = translateCeilingMs(submittedChars, req.targets.length, {
    oneShot: req.oneShot,
    queued: req.queued,
  });
  const stallMs = translateStallMs(req.warm);
  const clock = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? 1_000;
  // Only a race WE abandoned owes the server a cancel; set at the catch.
  let lost: TranslateFailure | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  req.onStart?.({ progressId, ceilingMs, stallMs, cold: req.warm !== true });
  try {
    const r = await Promise.race([
      deps.translate({
        serverUrl: req.serverUrl,
        backendId: req.backendId,
        // Prior phrases ride along as context segments; only the last result
        // (the current text) is consumed.
        texts: [...req.context, original],
        targets: req.targets,
        source: req.source?.trim() ? req.source.trim() : null,
        model: req.model,
        mode: req.mode,
        glossary: req.glossary,
        contextSegments: req.contextSegments ?? (req.context.length ? req.context.length : null),
        progressId,
        capturedId: req.capturedId ?? null,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new BudgetExpired(`no answer within ${Math.round(ceilingMs / 1000)}s`)),
          ceilingMs,
        );
      }),
      // The stall detector. Elapsed time cannot tell a slow GPU from a wedged
      // one; a progress entry that stops advancing can. Same idle-timer shape
      // the server uses to decide when to release a held log receipt.
      new Promise<never>((_, rej) => {
        const poll = deps.pollProgress;
        if (!poll) return; // no progress endpoint — the ceiling is the only guard
        let lastAdvance = clock();
        let lastSig: string | null = null;
        watchdog = setInterval(() => {
          void poll({ serverUrl: req.serverUrl, backendId: req.backendId, progressId })
            .then((p) => {
              if (p) req.onProgress?.(p);
              // `position` moves within a stage that reports no fraction, so it
              // belongs in the signature: without it a long single-target pass
              // reads as frozen.
              const sig = p ? `${p.stage ?? ""}|${p.progress ?? ""}|${p.position ?? ""}` : "";
              if (sig !== lastSig) {
                lastSig = sig;
                lastAdvance = clock();
                return;
              }
              if (clock() - lastAdvance >= stallMs) {
                rej(new BudgetExpired(`no progress for ${Math.round(stallMs / 1000)}s`));
              }
            })
            // A failed poll is NOT a stall: an older backend has no progress
            // endpoint at all, and one dropped request must never abandon a
            // translation that is running fine. Restamping degrades this to
            // "ceiling only", which is the conservative direction.
            .catch(() => {
              lastAdvance = clock();
            });
        }, pollMs);
      }),
      new Promise<never>((_, rej) => {
        const h = req.abort;
        if (!h) return; // never settles — a race member that simply doesn't participate
        if (h.aborted) rej(new Aborted("translation abandoned"));
        else h.onAbort(() => rej(new Aborted("translation abandoned")));
      }),
    ]);
    const lastIdx = r.results.length - 1;
    const last = r.results[lastIdx] ?? {};
    // A target the server's quality guard KEPT as the source text is not a translation
    // (text.rs: "the frontend must not present those as translations"). Presenting it as
    // one typed the untranslated original under the target's label — worse than the
    // failure path, which at least says so. A kept target reads as a missing one here, so
    // "every target kept" falls into the EmptyTranslation fallback below.
    const kept = new Set(r.kept?.[lastIdx] ?? []);
    // Keep the language keys alongside the parts. Same iteration, same
    // drop-a-missing-target rule — the parts array is derived FROM the map so
    // the two can never disagree about which targets came back.
    const byLang: Record<string, string> = {};
    for (const lang of req.targets) {
      const t = last[lang]?.trim();
      if (t && !kept.has(lang)) byLang[lang] = t;
    }
    const parts = Object.values(byLang);
    if (!parts.length) throw new EmptyTranslation("empty translation");
    // One block per language, blank-line separated — the transcript itself may
    // contain single line breaks, so a lone \n wouldn't read as a boundary.
    return {
      text: (req.includeOriginal ? [original.trim(), ...parts] : parts).join("\n\n"),
      ok: true,
      byLang,
    };
  } catch (e) {
    lost =
      e instanceof BudgetExpired
        ? "timeout"
        : e instanceof Aborted
          ? "cancelled"
          : e instanceof EmptyTranslation
            ? "empty"
            : "error";
    return { text: original, ok: false, cause: lost, error: e };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (watchdog !== undefined) clearInterval(watchdog);
    // The GPU is still working on a translation nobody will read — stop it. NOT
    // on success (the request is over), and NOT on a rejected request or an
    // empty answer (the server already finished; a cancel would only 404).
    if (lost === "timeout" || lost === "cancelled") {
      try {
        void Promise.resolve(
          deps.cancel({ serverUrl: req.serverUrl, backendId: req.backendId, progressId }),
        ).catch(() => {});
      } catch {
        /* best-effort */
      }
    }
  }
}
