// The dictation translate call, extracted from streaming.ts so it can be
// TESTED. Nothing in this repo mocks Tauri (`isTauri` is false under vitest and
// `vi.mock` is used nowhere), so the transport reaches this module as injected
// parameters — the same idiom runChunkedTranslate uses.
//
// Two bugs live here, and both are why the seam exists:
//   • The budget was derived from the TEXT LENGTH alone, so a 73-character
//     sentence got 3.3 s while a cold llama.cpp server needed 13 s (12.3 s of
//     it a GGUF load). Every first phrase of a session lost that race and
//     "translation timed out" was reported for work that was progressing fine.
//   • Losing the race cancelled NOTHING: no progressId was ever sent, so the
//     request kept running against Rust's 3600 s TEXT_TRANSLATE_TIMEOUT and the
//     GPU finished a translation nobody would read.
import type { TextTranslationResult } from "./api";

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
    model?: string;
    mode?: "fluent" | "faithful";
    glossary?: string;
    contextSegments?: number | null;
    progressId?: string | null;
    capturedId?: string | null;
  }) => Promise<TextTranslationResult>;
  /** Best-effort server-side abort. Called ONLY when we stopped waiting. */
  cancel: (args: { serverUrl: string; backendId: string; progressId: string }) => unknown;
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
   *  progress poller. */
  onStart?: (info: { progressId: string; budgetMs: number; cold: boolean }) => void;
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

/** A cold model load (download + GGUF into VRAM) is tens of seconds, and the
 *  stop-timing one-shot has nothing queued behind it, so it can afford to wait.
 *
 *  | case                                    | budget                 |
 *  | warm === true                           | the length formula     |
 *  | oneShot (stop-timing) && not warm       | 60 s                   |
 *  | live phrase, not warm, queued <= 1      | 20 s                   |
 *  | live phrase, not warm, queued > 1       | the length formula     |
 *
 *  WHY the live cap is 20 s and not the one-shot's 60 s: a phrase landing a
 *  minute after it was spoken, while the user has kept talking, is WORSE than
 *  the original landing now. And why a backlog falls back to the short formula:
 *  a queue means phrases are already waiting on this one — stalling it stalls
 *  them all, so take the original and keep the typing current. */
export const COLD_ONESHOT_MS = 60_000;
export const COLD_LIVE_MS = 20_000;
export function translateBudgetMs(
  len: number,
  o: { warm: boolean | null; oneShot: boolean; queued: number },
): number {
  const byLength = Math.min(60_000, Math.max(2_000, 1_500 + len * 25));
  if (o.warm === true) return byLength;
  if (o.oneShot) return COLD_ONESHOT_MS;
  if (o.queued > 1) return byLength;
  return COLD_LIVE_MS;
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
  const budgetMs = translateBudgetMs(original.length, {
    warm: req.warm,
    oneShot: req.oneShot,
    queued: req.queued,
  });
  // Only a race WE abandoned owes the server a cancel; set at the catch.
  let lost: TranslateFailure | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  req.onStart?.({ progressId, budgetMs, cold: req.warm !== true });
  try {
    const r = await Promise.race([
      deps.translate({
        serverUrl: req.serverUrl,
        backendId: req.backendId,
        // Prior phrases ride along as context segments; only the last result
        // (the current text) is consumed.
        texts: [...req.context, original],
        targets: req.targets,
        model: req.model,
        mode: req.mode,
        glossary: req.glossary,
        contextSegments: req.contextSegments ?? (req.context.length ? req.context.length : null),
        progressId,
        capturedId: req.capturedId ?? null,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new BudgetExpired("translation timed out")), budgetMs);
      }),
      new Promise<never>((_, rej) => {
        const h = req.abort;
        if (!h) return; // never settles — a race member that simply doesn't participate
        if (h.aborted) rej(new Aborted("translation abandoned"));
        else h.onAbort(() => rej(new Aborted("translation abandoned")));
      }),
    ]);
    const last = r.results[r.results.length - 1] ?? {};
    // Keep the language keys alongside the parts. Same iteration, same
    // drop-a-missing-target rule — the parts array is derived FROM the map so
    // the two can never disagree about which targets came back.
    const byLang: Record<string, string> = {};
    for (const lang of req.targets) {
      const t = last[lang]?.trim();
      if (t) byLang[lang] = t;
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
