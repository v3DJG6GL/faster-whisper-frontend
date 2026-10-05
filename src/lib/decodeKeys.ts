// The ONE table of client decode keys (`decode_overrides` on the wire). Everything that needs to
// know a key reads it from here: the sync sanitizer (bounds, string caps, which text keeps "\n"),
// the inherit derivations (inherit.ts), the "· n set" counts and the editors' row tables. A key
// added to `DecodeOverrides` without a row here is a compile error (`satisfies` below).
//
// Bounds mirror the backend's field metadata (config_store.AdminConfig, frozen in the settings
// batch contract 2026-10-05). The server clamps every value too and stays authoritative; the app
// clamps to the same numbers so a synced value is never one the server would refuse.
//
// Text semantics: absent = inherit, "" = an explicit empty override, null is never stored.

import { hasOwn } from "./own";
import type { DecodeOverrides } from "./types";

export type DecodeKey = keyof DecodeOverrides;

/** `ladder` = a number, or a comma list of retry rungs ("0.0,0.2,0.4") — temperature only. */
export type KeyKind = "int" | "float" | "bool" | "text" | "ladder";

/** Where a key's row lives. `primary` = the always-visible decode fields; `live` = live
 *  dictation only (the stream handshake; every batch request drops it); `picker` = not a
 *  decode row at all (multilingual rides the spoken-language picker). */
export type KeySection = "primary" | "vad" | "thresholds" | "sampling" | "vocab" | "langdetect" | "live" | "picker";

export interface KeySpec {
  kind: KeyKind;
  /** The server setting the key overrides — the row's title. */
  env: string;
  section: KeySection;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Text: the longest value the server accepts (characters). */
  maxLen?: number;
  /** Text: "\n" is part of the value (escaped as `\n` in the editor), never folded away. */
  multiline?: boolean;
  /** Live dictation only (every `streaming_` key): stripped from batch requests. */
  live?: boolean;
  /** Typed into the focused app: an inbound sync change needs the user's approval. */
  typed?: boolean;
  /** What a server value of null means here ("off", "none"). */
  nullText?: string;
  /** Ladder: the most rungs the server keeps. */
  maxRungs?: number;
}

export const DECODE_KEYS = {
  // ── primary ──
  beam_size: { kind: "int", env: "BEAM_SIZE", section: "primary", min: 1, max: 20, step: 1 },
  temperature: { kind: "ladder", env: "TEMPERATURE", section: "primary", min: 0, max: 1, step: 0.1, maxLen: 64, maxRungs: 16 },
  condition_on_previous_text: { kind: "bool", env: "CONDITION_ON_PREVIOUS_TEXT", section: "primary" },
  vad_filter: { kind: "bool", env: "VAD_FILTER", section: "primary" },
  hotwords: { kind: "text", env: "DEFAULT_HOTWORDS", section: "primary", maxLen: 2048, nullText: "none" },
  // ── Voice activity (VAD) ──
  vad_threshold: { kind: "float", env: "VAD_THRESHOLD", section: "vad", min: 0, max: 1, step: 0.05 },
  vad_min_silence_duration_ms: { kind: "int", env: "VAD_MIN_SILENCE_MS", section: "vad", min: 0, max: 10000, step: 50, unit: "ms" },
  vad_speech_pad_ms: { kind: "int", env: "VAD_SPEECH_PAD_MS", section: "vad", min: 0, max: 2000, step: 10, unit: "ms" },
  // ── Recognition thresholds ──
  hallucination_silence_threshold: {
    kind: "float", env: "HALLUCINATION_SILENCE_THRESHOLD", section: "thresholds", min: 0, max: 60, step: 0.5, unit: "s", nullText: "off",
  },
  best_of: { kind: "int", env: "BEST_OF", section: "thresholds", min: 1, max: 20, step: 1 },
  no_speech_threshold: { kind: "float", env: "NO_SPEECH_THRESHOLD", section: "thresholds", min: 0, max: 1, step: 0.05, nullText: "off" },
  log_prob_threshold: { kind: "float", env: "LOG_PROB_THRESHOLD", section: "thresholds", min: -10, max: 0, step: 0.5, nullText: "off" },
  compression_ratio_threshold: {
    kind: "float", env: "COMPRESSION_RATIO_THRESHOLD", section: "thresholds", min: 0, max: 10, step: 0.1, nullText: "off",
  },
  // ── Beam & sampling ──
  patience: { kind: "float", env: "PATIENCE", section: "sampling", min: 0.5, max: 5, step: 0.1 },
  length_penalty: { kind: "float", env: "LENGTH_PENALTY", section: "sampling", min: 0.1, max: 5, step: 0.1 },
  repetition_penalty: { kind: "float", env: "REPETITION_PENALTY", section: "sampling", min: 0.5, max: 5, step: 0.1 },
  no_repeat_ngram_size: { kind: "int", env: "NO_REPEAT_NGRAM_SIZE", section: "sampling", min: 0, max: 10, step: 1 },
  // ── Vocabulary & punctuation ──
  suppress_tokens: { kind: "text", env: "SUPPRESS_TOKENS", section: "vocab", maxLen: 256 },
  suppress_chars: { kind: "text", env: "SUPPRESS_CHARS", section: "vocab", maxLen: 64, nullText: "none" },
  prepend_punctuations: { kind: "text", env: "PREPEND_PUNCTUATIONS", section: "vocab", maxLen: 64 },
  append_punctuations: { kind: "text", env: "APPEND_PUNCTUATIONS", section: "vocab", maxLen: 64 },
  output_prefix: { kind: "text", env: "OUTPUT_PREFIX", section: "vocab", maxLen: 512, typed: true },
  output_suffix: { kind: "text", env: "OUTPUT_SUFFIX", section: "vocab", maxLen: 512, typed: true },
  // ── Language detection (only with an auto-detected language) ──
  language_detection_segments: { kind: "int", env: "LANGUAGE_DETECTION_SEGMENTS", section: "langdetect", min: 1, max: 10, step: 1 },
  language_detection_threshold: { kind: "float", env: "LANGUAGE_DETECTION_THRESHOLD", section: "langdetect", min: 0, max: 1, step: 0.05 },
  // ── Live dictation (stream handshake only) ──
  streaming_vad_threshold: { kind: "float", env: "STREAMING_VAD_THRESHOLD", section: "live", live: true, min: 0, max: 1, step: 0.05 },
  streaming_vad_inner_silence_ms: {
    kind: "int", env: "STREAMING_VAD_INNER_SILENCE_MS", section: "live", live: true, min: 0, max: 5000, step: 100, unit: "ms",
  },
  streaming_vad_outer_silence_ms: {
    kind: "int", env: "STREAMING_VAD_OUTER_SILENCE_MS", section: "live", live: true, min: 100, max: 10000, step: 100, unit: "ms",
  },
  streaming_hard_break_silence_ms: {
    kind: "int", env: "STREAMING_HARD_BREAK_SILENCE_MS", section: "live", live: true, min: 0, max: 120000, step: 1000, unit: "ms",
  },
  streaming_hard_break_separator: {
    kind: "text", env: "STREAMING_HARD_BREAK_SEPARATOR", section: "live", live: true, maxLen: 8, multiline: true, typed: true,
  },
  // ── Spoken-language picker ("Multiple languages") ──
  multilingual: { kind: "bool", env: "MULTILINGUAL", section: "picker" },
} as const satisfies Record<DecodeKey, KeySpec>;

/** Every client decode key, in table order. */
export const DECODE_KEY_LIST = Object.keys(DECODE_KEYS) as DecodeKey[];

export function isDecodeKey(k: string): k is DecodeKey {
  return hasOwn(DECODE_KEYS, k);
}

/** The spec of a known key (widened, so optional fields read without narrowing). */
export function keySpec(k: DecodeKey): KeySpec {
  return DECODE_KEYS[k];
}

const keysWhere = (pred: (s: KeySpec) => boolean): ReadonlySet<DecodeKey> =>
  new Set(DECODE_KEY_LIST.filter((k) => pred(keySpec(k))));

/** Tri-state booleans. */
export const BOOL_KEYS = keysWhere((s) => s.kind === "bool");
/** Live dictation only — the stream handshake carries them, batch requests never do. */
export const LIVE_KEYS = keysWhere((s) => s.live === true);
/** Text typed into the focused app (separator, output prefix/suffix) — security-gated on sync. */
export const TYPED_TEXT_KEYS = keysWhere((s) => s.typed === true);

/** What a server value of null reads as, per key. */
export const NULL_TEXT: Partial<Record<DecodeKey, string>> = Object.fromEntries(
  DECODE_KEY_LIST.flatMap((k) => {
    const t = keySpec(k).nullText;
    return t ? [[k, t]] : [];
  }),
);

/** How many keys an override object sets in one editor block: `decode` = the decode fields (not
 *  live, not the language picker's), `live` = the live dictation block. */
export function countSet(ov: DecodeOverrides | undefined, scope: "decode" | "live"): number {
  if (!ov) return 0;
  return DECODE_KEY_LIST.filter((k) => {
    if (ov[k] === undefined) return false;
    const s = keySpec(k).section;
    return scope === "live" ? s === "live" : s !== "live" && s !== "picker";
  }).length;
}

// ── sanitizing (sync pull / file import) ────────────────────────────────────

const clamp = (n: number, min = -Infinity, max = Infinity) => Math.min(max, Math.max(min, n));

/** C0 controls and DEL; a multiline value keeps its "\n". */
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** At most `n` characters (code points, as the server counts), never splitting a pair. */
function capChars(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

/** A temperature ladder kept verbatim when it is valid, so a synced value comes back exactly as
 *  typed; out-of-range rungs are clamped and extra rungs dropped (rewritten only then). A rung
 *  that is not a number drops the whole value — the server would drop it too. */
function sanitizeLadder(s: string, spec: KeySpec): string | undefined {
  const text = s.replace(CONTROLS, "").trim();
  if (!text) return undefined;
  const parts = text.split(",").map((r) => r.trim());
  const rungs = parts.map((r) => (r === "" ? NaN : Number(r)));
  if (rungs.some((r) => !Number.isFinite(r))) return undefined;
  const max = spec.maxRungs ?? rungs.length;
  const fits = rungs.length <= max && rungs.every((r) => r === clamp(r, spec.min, spec.max));
  const out = fits ? text : rungs.slice(0, max).map((r) => String(clamp(r, spec.min, spec.max))).join(",");
  return out.length <= (spec.maxLen ?? Infinity) ? out : undefined;
}

/** One value as the table allows it for `key`, or undefined when it can't be kept. */
export function sanitizeDecodeValue(key: DecodeKey, v: unknown): number | boolean | string | undefined {
  const spec = keySpec(key);
  switch (spec.kind) {
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "int":
    case "float": {
      if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
      const n = spec.kind === "int" ? Math.round(v) : v;
      return clamp(n, spec.min, spec.max);
    }
    case "ladder":
      if (typeof v === "number") return Number.isFinite(v) ? clamp(v, spec.min, spec.max) : undefined;
      return typeof v === "string" ? sanitizeLadder(v, spec) : undefined;
    case "text": {
      if (typeof v !== "string") return undefined;
      const cleaned = v.replace(spec.multiline ? CONTROLS_BUT_NEWLINE : CONTROLS, "");
      return capChars(cleaned, spec.maxLen ?? 512);
    }
  }
}

/** A key a newer app may add: same shape as the server's client keys. */
const FUTURE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
/** Ceiling on the keys one override object carries (31 known today). */
const MAX_DECODE_KEYS = 64;

/**
 * The `decodeOverrides` leaf of a synced or imported Profile/Backend. Known keys are clamped by
 * the table (numbers to the server's bounds, text to its length, "\n" kept only where it is part
 * of the value); a key this build does not know passes only as a finite number or a boolean, so a
 * newer peer's numeric knob survives the round trip while unknown text — which could be typed
 * into an app — does not. Anything else (a string root, an array, nested objects) is dropped.
 * Rust holds the object as opaque JSON and forwards it into every request, so this is the only
 * floor it gets.
 */
export function clampDecodeOverrides(v: unknown): DecodeOverrides | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, number | boolean | string> = {};
  let n = 0;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_DECODE_KEYS) break;
    let x: number | boolean | string | undefined;
    if (isDecodeKey(k)) x = sanitizeDecodeValue(k, raw);
    else if (FUTURE_KEY.test(k) && (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw)))) x = raw;
    if (x === undefined) continue;
    out[k] = x;
    n++;
  }
  return out as DecodeOverrides;
}
