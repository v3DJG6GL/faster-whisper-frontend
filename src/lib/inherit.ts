// One wording for "this control takes its value from the layer below": the word, then what that
// value IS, so a reader never has to open another screen to learn what "Inherit" means.
//
//   Inherit · on        — an override layer (Profile over Backend, Backend over server, App rule
//                         over Profile/Settings)
//   Default · large-v3  — a per-run choice on the Transcribe page
//
// The server's own decode values come from GET /v1/request-default-settings (serverInherited); a value
// nobody can name (the server is unreachable) leaves the bare word.

import type { DecodeDefault, DecodeDefaults, InheritedValues } from "./types";
import { BOOL_KEYS, isDecodeKey, keySpec, NULL_TEXT, type DecodeKey } from "./decodeKeys";

export type InheritWord = "Inherit" | "Default";

export function inheritLabel(value: string | null | undefined, word: InheritWord | "Set by server" = "Inherit"): string {
  const v = typeof value === "string" ? value.trim() : "";
  return v ? `${word} · ${v}` : word;
}

/** A tri-state boolean's inherited side as the word its segments use. */
export function onOff(v: boolean | null | undefined): string | undefined {
  return typeof v === "boolean" ? (v ? "on" : "off") : undefined;
}

export type { DecodeKey };
/** Which decode the values are for: a batch file run, or live dictation (its final decode). */
export type DecodeMode = "batch" | "stream";


/** Why live dictation pins condition_on_previous_text (tooltip + screen-reader text). */
export const DICTATION_PIN_REASON = "Live dictation turns this off to stop echoed text.";
export const LOCKED_REASON = "Your server admin fixed this value.";

/** The tooltip line naming where an inherited value comes from. */
export function sourceText(d: Pick<DecodeDefault, "source" | "label">, model: string): string {
  const short = model.split("/").pop() || model;
  switch (d.source) {
    case "model":
      return `Server default for ${short} (model config)`;
    case "account":
      return d.label ? `Set for your account on the server (${d.label})` : "Set for your account on the server";
    case "override_profile":
      return d.label ? `From the server override profile (${d.label})` : "From the server override profile";
    case "builtin":
      return "faster-whisper's built-in default";
    default:
      return "Server default";
  }
}

/** One server value as the editor shows it, or undefined when it can't be shown. A bool key
 *  takes only a real boolean ("false" would read as on); null takes the key's "none"/"off"
 *  (decodeKeys `nullText`); a multiline key's "\n" is a value, not blank space. */
function shownValue(key: DecodeKey, v: DecodeDefault["value"] | undefined): string | number | boolean | undefined {
  if (BOOL_KEYS.has(key)) return typeof v === "boolean" ? v : undefined;
  if (v === null) return NULL_TEXT[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return (keySpec(key).multiline ? v !== "" : v.trim()) ? v : undefined;
  return undefined;
}

export interface ServerInherited {
  /** What a blank field inherits: server values, then `below` over them, locked keys back to the server's. */
  values: InheritedValues;
  /** Tooltip per key naming the layer the value comes from. */
  sources: Partial<Record<DecodeKey, string>>;
  /** Keys an admin locked: the control is read-only and shows the server value. */
  locked: ReadonlySet<DecodeKey>;
  /** Keys the decode forces whatever is sent (live dictation's condition_on_previous_text). */
  pinned: Partial<Record<DecodeKey, { value: string; reason: string }>>;
  /** Keys whose `below` value the server ignores because they are locked. */
  ignored: DecodeKey[];
  /** The server's default prompt (undefined = none), and whether it is locked. */
  prompt: { value: string | undefined; locked: boolean; source: string } | undefined;
}

/**
 * The decode baseline an editor inherits. `dd` is the server's resolved defaults (already
 * including the server-bound and requested override profiles); `below` the client layers in
 * between (a profile editor passes its backend's defaults; the backend editor passes nothing),
 * named by `belowSource` in the tooltip. A client value beats the server's unless the key is
 * locked; in `stream` mode live dictation's own best_of replaces the batch one and
 * condition_on_previous_text is pinned.
 */
export function serverInherited(
  dd: DecodeDefaults | null | undefined,
  below?: InheritedValues,
  mode: DecodeMode = "batch",
  belowSource = "Backend default",
): ServerInherited {
  const values: InheritedValues = {};
  const sources: Partial<Record<DecodeKey, string>> = {};
  const locked = new Set<DecodeKey>();
  const pinned: ServerInherited["pinned"] = {};
  const model = dd?.model ?? "";
  if (dd?.settings) {
    // Known keys only: a newer server's key this build has no row for has nowhere to show.
    for (const key of Object.keys(dd.settings).filter(isDecodeKey)) {
      const d = dd.settings[key];
      if (!d || typeof d !== "object") continue;
      const v = shownValue(key, d.value);
      if (v !== undefined) {
        values[key] = v;
        sources[key] = sourceText(d, model);
      }
      if (d.locked === true) locked.add(key);
    }
    if (mode === "stream" && dd.streaming) {
      const best = dd.streaming.best_of?.value;
      if (typeof best === "number" && Number.isFinite(best) && !locked.has("best_of")) {
        values.best_of = best;
        sources.best_of = "Live dictation's own default";
      }
      const cond = dd.streaming.condition_on_previous_text;
      if (cond?.pinned && typeof cond.final === "boolean") {
        pinned.condition_on_previous_text = { value: onOff(cond.final)!, reason: DICTATION_PIN_REASON };
      }
    }
  }
  const ignored: DecodeKey[] = [];
  for (const key of Object.keys(below ?? {}) as DecodeKey[]) {
    const v = below![key];
    if (v === undefined) continue;
    if (locked.has(key)) {
      ignored.push(key);
      continue;
    }
    values[key] = v;
    sources[key] = belowSource;
  }
  const p = dd?.prompt;
  const prompt =
    p && typeof p === "object"
      ? {
          value: typeof p.value === "string" && p.value.trim() ? p.value : undefined,
          locked: p.locked === true,
          source: sourceText(p, model),
        }
      : undefined;
  return { values, sources, locked, pinned, ignored, prompt };
}
