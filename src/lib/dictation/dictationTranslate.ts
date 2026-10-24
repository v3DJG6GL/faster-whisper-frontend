// The dictation translate call. The transport arrives as injected parameters,
// so its tests need no Tauri mock — the same idiom runChunkedTranslate uses.
//
// Elapsed time is a ceiling only; the real signal is whether the server's
// progress entry is still moving. A length-derived budget cannot work: a cold
// llama.cpp server spends ~12 s loading the GGUF, and the server translates
// every submitted context segment for EVERY target. Losing the race must cancel
// by progressId, or the request runs on against Rust's 3600 s
// TEXT_TRANSLATE_TIMEOUT and the GPU finishes a translation nobody reads.
import type { TextTranslationResult } from "../api";
import type { BatchProgress } from "../types";
import { newProgressId } from "../ids";
import { translateSourceCode } from "../languages";

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
    clientJob?: string | null;
  }) => Promise<TextTranslationResult>;
  /** Best-effort server-side abort. Called ONLY when we stopped waiting. */
  cancel: (args: { serverUrl: string; backendId: string; progressId: string }) => unknown;
  /** The server's progress entry for `progressId`. This is what makes the
   *  stall detector possible — without it there is nothing to distinguish a
   *  wedged server from a slow one, and only the ceiling applies. */
  pollProgress?: (args: {
    serverUrl: string;
    backendId: string;
    progressId: string;
  }) => Promise<BatchProgress | null>;
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
  /** The session's client-minted id (the stream handshake's `client_job`), so the
   *  server's translate receipt names the session it belongs to. */
  clientJob?: string | null;
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

/** A translated phrase as it is typed: one block per language, blank-line separated, the
 *  original first when the session includes it — the transcript itself may contain single line
 *  breaks, so a lone \n wouldn't read as a boundary. */
export function joinTranslationBlocks(parts: readonly string[], original?: string): string {
  return (original != null ? [original.trim(), ...parts] : parts).join("\n\n");
}

export interface DictationTranslateResult {
  /** The translation, or the ORIGINAL text on any failure — the user's words
   *  must still land. */
  text: string;
  ok: boolean;
  cause?: TranslateFailure;
  /** The raw failure, for the doorway's `shortCause`. */
  error?: unknown;
  /** The same translations, still keyed by language. The injected `text` join
   *  is lossy (a transcript has its own line breaks, so the blank-line
   *  separators can't be split back), and this is the only place the
   *  language→text association exists — History and the log receipt need it
   *  from here. Absent on the failure paths. */
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
 *  increment, so `1` already means one task ahead of us. */
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
 *  silence really is a wedge — but the text route only ticks when a whole
 *  target FINISHES, so one target's pass over `chars` is silent by design: the
 *  warm allowance is at least twice its priced cost (never past `ceilingMs`). */
export const STALL_WARM_MS = 8_000;
export const STALL_COLD_MS = 45_000;
export function translateStallMs(warm: boolean | null, chars = 0, ceilingMs = Infinity): number {
  if (warm !== true) return STALL_COLD_MS;
  return Math.min(ceilingMs, Math.max(STALL_WARM_MS, Math.round(pricedMs(chars, 1) * 2)));
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

/** Translate one dictation payload, or give the ORIGINAL text back. Never
 *  throws — every failure is a `cause` the caller reports once per session. */
export async function runDictationTranslate(
  req: DictationTranslateRequest,
  deps: TranslateDeps,
): Promise<DictationTranslateResult> {
  const original = req.text;
  const progressId = (deps.newId ?? newProgressId)();
  // The server translates EVERY submitted segment into every target and uses the
  // depth only to pick context lines, so phrases beyond the profile's depth would
  // cost full passes (and still lend implicit context with context turned off).
  // No depth = inherit: submit what the stream kept, but send no depth, so the server
  // applies its own TRANSLATION_CONTEXT_SEGMENTS (off or lower than what was kept). The
  // client cannot learn that depth: /v1/translate resolves it with no override profile
  // and no model, which request-default-settings cannot express, so no inherited bound.
  const depth =
    typeof req.contextSegments === "number"
      ? Math.max(0, Math.floor(req.contextSegments))
      : req.context.length;
  const context = depth > 0 ? req.context.slice(-depth) : [];
  const submittedChars =
    context.reduce((n, c) => n + c.length, 0) + original.length;
  const ceilingMs = translateCeilingMs(submittedChars, req.targets.length, {
    oneShot: req.oneShot,
    queued: req.queued,
  });
  const stallMs = translateStallMs(req.warm, submittedChars, ceilingMs);
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
        texts: [...context, original],
        targets: req.targets,
        // Only a code reaches the text route (it 422s a word like "english"): the shared rule.
        source: translateSourceCode(req.source),
        model: req.model,
        mode: req.mode,
        glossary: req.glossary,
        contextSegments: req.contextSegments ?? null,
        progressId,
        capturedId: req.capturedId ?? null,
        clientJob: req.clientJob ?? null,
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
              // reads as frozen. So do the step and the target: a multi-target
              // run's per-target tick is its only sign of life.
              const sig = p
                ? `${p.stage ?? ""}|${p.progress ?? ""}|${p.position ?? ""}|${p.step ?? ""}|${p.target ?? ""}|${p.targetProgress ?? ""}`
                : "";
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
    // The parts array is derived FROM the map so the two can never disagree
    // about which targets came back.
    const byLang: Record<string, string> = {};
    for (const lang of req.targets) {
      const t = last[lang]?.trim();
      if (t && !kept.has(lang)) byLang[lang] = t;
    }
    const parts = Object.values(byLang);
    if (!parts.length) throw new EmptyTranslation("empty translation");
    return {
      text: joinTranslationBlocks(parts, req.includeOriginal ? original : undefined),
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
