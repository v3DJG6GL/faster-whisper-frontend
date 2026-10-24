// Language names and the pure logic behind the language pickers. Every rule a picker
// follows — what a search matches, which groups show in which order, what a pick does to the
// decode overrides — lives here as a plain function, so it is tested without a DOM.

import { ownProp } from "./own";
import { dropJoiners, safeDisplayText } from "./sanitize";
import type { DecodeOverrides } from "./types";

/** Every language Whisper decodes — faster-whisper's tokenizer list (incl. yue), in its order. */
export const WHISPER_LANGUAGES: readonly string[] = (
  "af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw he " +
  "hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne " +
  "nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk " +
  "ur uz vi yi yo yue zh"
).split(" ");

/** The spoken picker's "Multiple languages" row: the language is sent as auto-detect and the
 *  decode override `multilingual` turns on (detection per 30 s window). Not a language code. */
export const MULTI_LANGUAGE = "multi";

/** How many translation targets one run takes — the server translates every context segment
 *  once per target, so the cost is linear in this number and the cap is a real one. */
export const TRANSLATION_MAX_TARGETS = 8;

/** A server's target cap as the app takes it: the lower of it and the app's ceiling; anything
 *  that is not a number ≥ 1 (unknown, an older server) = the ceiling — an absent cap never
 *  narrows a choice. maxTranslationTargets reads it from caps; the language picker window gets
 *  it as a bare value in its seed. */
export function targetCap(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return TRANSLATION_MAX_TARGETS;
  return Math.min(TRANSLATION_MAX_TARGETS, Math.floor(limit));
}

/** Names the runtime gets wrong or spells differently from Whisper's own list (WebKit's ICU
 *  may not know the deprecated `jw`, says "Bangla" for bn, …), plus the pinned "auto". */
const LABEL_FIX: Record<string, string> = {
  auto: "Auto-detect",
  bn: "Bengali",
  haw: "Hawaiian",
  ht: "Haitian Creole",
  jw: "Javanese",
  tl: "Filipino",
  yue: "Cantonese",
  "zh-Hant": "Traditional Chinese",
};

// English script names ("Latin" for Latn), built lazily like the language names below.
let scriptNames: Intl.DisplayNames | null | undefined;
function scriptName(code: string): string | undefined {
  if (scriptNames === undefined) {
    try {
      scriptNames = new Intl.DisplayNames(["en"], { type: "script", fallback: "none" });
    } catch {
      scriptNames = null;
    }
  }
  try {
    return scriptNames?.of(code) || undefined;
  } catch {
    return undefined;
  }
}

// English names, built lazily; null where the runtime lacks Intl.DisplayNames.
let displayNames: Intl.DisplayNames | null | undefined;
function intlName(code: string): string | undefined {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) || undefined;
  } catch {
    return undefined; // not a well-formed language tag
  }
}

/** The language a code counts for — its primary subtag, lowercased ("de-CH", "de_CH" and
 *  "de-orig" are German). */
export function primarySubtag(code: string | null | undefined): string {
  return (code ?? "").toLowerCase().split(/[-_]/)[0];
}

/** A transcript language as a translation `source`: only a code ("en", "pt-BR", "zh_Hans") —
 *  the text route 422s anything else, failing every chunk. An imported JSON may name its
 *  language as a word ("english"), which goes out as null (auto-detect) instead. */
export function translateSourceCode(lang: string | null | undefined): string | null {
  const l = lang?.trim();
  return l && /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/i.test(l) ? l : null;
}

/** A language code as chips, tabs and summaries show it: langText in caps ("DE", "PT-BR"). */
export function langCode(code: string, max = 16): string {
  return langText(code, max).toUpperCase();
}

/** A language code as the display filter renders it, minus the ZWNJ/ZWJ it keeps (they shape
 *  scripts and emoji in prose; no language code carries one) — so a joiner-only code reads empty
 *  and a gate on it skips the part or shows "??", never a blank pill or row. */
export function langText(code: string, max = 16): string {
  return safeDisplayText(dropJoiners(code), max);
}

/** Language codes as a list shows them: each one through langText (cap 12, as every list site
 *  uses), trimmed, with blanks (format- or joiner-only codes) dropped. */
export function langTexts(codes: readonly string[], max = 12): string[] {
  return codes.map((c) => langText(c, max).trim()).filter(Boolean);
}

/** A dictation route's source as the tray and the target picker write it, sanitized and capped
 *  at 12. Only an unset or "auto" language reads AUTO: a set one of only format characters (or
 *  whitespace) is still sent verbatim — Rust's wire_language passes any non-empty code — so it
 *  reads "??". */
export function routeSourceCode(lang: string | null | undefined): string {
  return !lang || lang === "auto" ? "AUTO" : langCode(lang, 12).trim() || "??";
}

const labels = new Map<string, string>();
/** English name for a language code; an unknown code comes back unchanged. Cached: the pickers
 *  sort ~100 codes by it on every render. LABEL_FIX is read own-only — a server-listed code like
 *  "constructor" would otherwise come back as an Object.prototype function and throw in a sort. */
export function languageLabel(code: string): string {
  let l = labels.get(code);
  if (l === undefined) {
    l = ownProp(LABEL_FIX, code) ?? intlName(code) ?? code;
    labels.set(code, l);
  }
  return l;
}

/** Whisper's own spellings (its tokenizer's names and TO_LANGUAGE_CODE aliases) that the
 *  runtime names differently: ICU says "Filipino" for tl, "Burmese" for my, "Māori" for mi, …
 *  Read own-only, like LABEL_FIX. */
const NAME_ALIASES: Record<string, string> = {
  burmese: "my",
  cantonese: "yue",
  castilian: "es",
  flemish: "nl",
  haitian: "ht",
  javanese: "jw",
  letzeburgesch: "lb",
  mandarin: "zh",
  maori: "mi",
  moldavian: "ro",
  moldovan: "ro",
  myanmar: "my",
  nynorsk: "nn",
  panjabi: "pa",
  pushto: "ps",
  sinhalese: "si",
  tagalog: "tl",
  valencian: "ca",
};

let codesByName: Map<string, string> | undefined;
/** The Whisper code a language NAME stands for ("English", "english", "tagalog" → "en", "tl"),
 *  case-insensitive; undefined for a word no Whisper language goes by. An imported JSON (OpenAI's
 *  verbose_json) names its language as a word, which every track reader would otherwise take
 *  for an unknown code. */
export function languageCodeFromName(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  if (!codesByName) {
    codesByName = new Map();
    for (const code of WHISPER_LANGUAGES) {
      const label = languageLabel(code).toLowerCase();
      if (label !== code && !codesByName.has(label)) codesByName.set(label, code);
    }
  }
  return ownProp(NAME_ALIASES, key) ?? codesByName.get(key);
}

/** A language as a track files it: a code stays; a word that names a Whisper language
 *  ("english", what OpenAI's verbose_json writes — in an imported file or from a standard
 *  server) becomes its code; anything else stays as given. */
export function languageCodeOf(lang: string): string {
  // The name map first: a short name ("lao" for lo) also passes as a code. A Whisper code is
  // never renamed.
  const named = languageCodeFromName(lang);
  return named && !WHISPER_LANGUAGES.includes(lang.trim().toLowerCase()) ? named : lang;
}

/** A track's language as its titles and chips name it: the English name with the region in
 *  caps ("Portuguese (BR)"); a script subtag named with the language when the runtime knows the
 *  pair ("zh-Hant-TW" is "Traditional Chinese (TW)", "sr-Latn-RS" is "Serbian (Latin, RS)"); a code with
 *  no name in caps ("XX"). */
export function trackLanguageName(code: string): string {
  const exact = ownProp(LABEL_FIX, code); // "zh-Hant" is "Traditional Chinese", not "Chinese (HANT)"
  if (exact) return exact;
  const [base, second, third] = code.split("-");
  const b = base.toLowerCase();
  const key = second !== undefined && /^[A-Za-z]{4}$/.test(second)
    ? `${b}-${second[0].toUpperCase()}${second.slice(1).toLowerCase()}`
    : undefined;
  if (key !== undefined) {
    // A base whose name LABEL_FIX corrects keeps that name, with the runtime's script name, unless
    // the pair has its own fix: "bn-Beng" is "Bengali (Bangla)", not the runtime's "Bangla (Bangla)".
    const fixed = ownProp(LABEL_FIX, key) === undefined ? ownProp(LABEL_FIX, b) : undefined;
    const script = fixed !== undefined ? scriptName(key.slice(b.length + 1)) : undefined;
    const scripted = fixed === undefined ? languageLabel(key) : script ? `${fixed} (${script})` : key;
    if (scripted !== key) {
      if (third === undefined) return scripted;
      const region = third.toUpperCase();
      // "Serbian (Latin)" + RS is "Serbian (Latin, RS)", not "Serbian (Latin) (RS)".
      return scripted.endsWith(")") ? `${scripted.slice(0, -1)}, ${region})` : `${scripted} (${region})`;
    }
  }
  const name = languageLabel(b);
  return (name === b ? b.toUpperCase() : name) + (second !== undefined ? ` (${second.toUpperCase()})` : "");
}

const natives = new Map<string, string>();
/** The language's name in itself ("Deutsch" for de), or "" when the runtime has no data for it
 *  (it then falls back to another locale — that name is not native) or it equals the English one. */
export function nativeName(code: string): string {
  let n = natives.get(code);
  if (n === undefined) {
    n = "";
    try {
      const dn = new Intl.DisplayNames([code], { type: "language" });
      const own = new Intl.Locale(dn.resolvedOptions().locale).language === new Intl.Locale(code).language;
      const name = own ? dn.of(code) ?? "" : "";
      if (name && name !== code && name.toLowerCase() !== languageLabel(code).toLowerCase()) n = name;
    } catch {
      // no Intl support, or not a well-formed tag
    }
    natives.set(code, n);
  }
  return n;
}

/** Search by English name, native name (both substrings) or code (exact, or a region/script
 *  variant of it: "zh" finds zh-Hant). */
export function matchesLanguage(code: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const c = code.toLowerCase();
  return (
    c === q ||
    c.startsWith(`${q}-`) ||
    languageLabel(code).toLowerCase().includes(q) ||
    nativeName(code).toLowerCase().includes(q)
  );
}

const byName = (a: string, b: string) => languageLabel(a).localeCompare(languageLabel(b));
let sortedWhisper: string[] | undefined;
const whisperByName = () => (sortedWhisper ??= [...WHISPER_LANGUAGES].sort(byName));

/** English-only Whisper checkpoints (tiny.en … medium.en) can't detect or switch languages. */
export function isEnglishOnlyModel(model: string | null | undefined): boolean {
  return /\.en$/i.test(model?.trim() ?? "");
}

/** One row of a language list: a code (or a pinned value) and, for translation targets, whether
 *  the model does not officially support it. */
export interface LangRow {
  value: string;
  untested?: boolean;
}

export const untestedTitle = (r: LangRow) =>
  r.untested ? "Not in the model's supported list — quality unknown" : undefined;
export interface LangSection {
  /** "" = untitled (the pinned rows). */
  title: string;
  count?: number;
  rows: LangRow[];
}

const rowsOf = (codes: readonly string[]): LangRow[] => codes.map((value) => ({ value }));
/** Recents shown above the full list — enough for a working set without pushing the list down. */
const MAX_RECENT_SHOWN = 5;

/** The spoken-language picker's groups. Without a query: the pinned rows (the inherit row when
 *  the field inherits, Auto-detect, Multiple languages when offered), Recent, all languages by
 *  name. With one: the matching languages only. */
export function spokenSections(args: {
  query: string;
  recent: readonly string[];
  /** Offer the "" row (an override field that can inherit the layer below). */
  inherit?: boolean;
  /** Offer "Multiple languages". */
  multi?: boolean;
}): LangSection[] {
  if (args.query.trim()) {
    const hits = whisperByName().filter((c) => matchesLanguage(c, args.query));
    return [{ title: "Matches", count: hits.length, rows: rowsOf(hits) }];
  }
  const pinned = [...(args.inherit ? [""] : []), "auto", ...(args.multi ? [MULTI_LANGUAGE] : [])];
  const recent = args.recent.filter((c) => WHISPER_LANGUAGES.includes(c)).slice(0, MAX_RECENT_SHOWN);
  return [
    { title: "", rows: rowsOf(pinned) },
    ...(recent.length ? [{ title: "Recent", rows: rowsOf(recent) }] : []),
    { title: "All languages", count: WHISPER_LANGUAGES.length, rows: rowsOf(whisperByName()) },
  ];
}

/** The translation-target picker's groups. With the model's list known: Recent, "Supported by
 *  <model>", then every other language as "Not officially supported" (tagged "not tested").
 *  Unknown (null): one untagged group of all languages. The source language is left out. */
export function targetSections(args: {
  query: string;
  recent: readonly string[];
  supported: readonly string[] | null;
  modelName?: string;
  exclude?: string;
}): LangSection[] {
  const sup = args.supported;
  const all = [...new Set([...(sup ?? []), ...WHISPER_LANGUAGES])].filter((c) => c !== args.exclude);
  const row = (value: string): LangRow => (sup && !sup.includes(value) ? { value, untested: true } : { value });
  const q = args.query;
  const hits = all.filter((c) => matchesLanguage(c, q)).sort(byName);
  const groups: LangSection[] = [];
  if (!q.trim()) {
    const recent = args.recent.filter((c) => all.includes(c)).slice(0, MAX_RECENT_SHOWN);
    if (recent.length) groups.push({ title: "Recent", rows: recent.map(row) });
  }
  if (!sup) {
    groups.push({ title: q.trim() ? "Matches" : "All languages", count: hits.length, rows: hits.map(row) });
    return groups.filter((g) => g.rows.length);
  }
  const yes = hits.filter((c) => sup.includes(c));
  const no = hits.filter((c) => !sup.includes(c));
  const name = args.modelName?.trim();
  groups.push(
    { title: q.trim() ? "Supported" : name ? `Supported by ${name}` : "Supported", count: yes.length, rows: yes.map(row) },
    { title: "Not officially supported", count: no.length, rows: no.map(row) },
  );
  return groups.filter((g) => g.rows.length);
}

/** Add or remove a code, never past `max` — the multi-select pickers' tick. */
export function toggleCode(list: readonly string[], code: string, max: number): string[] {
  if (list.includes(code)) return list.filter((c) => c !== code);
  return list.length >= max ? [...list] : [...list, code];
}

/** The spoken picker's value for a stored language: "auto" with multilingual on (this layer's own
 *  value, else the inherited one) reads as "Multiple languages". */
export function spokenValue(language: string, own: boolean | undefined, inherited: boolean | undefined): string {
  return language === "auto" && (own ?? inherited) === true ? MULTI_LANGUAGE : language;
}

/** The language a spoken pick stores: "Multiple languages" is auto-detect plus the decode flag. */
export function spokenLanguage(picked: string): string {
  return picked === MULTI_LANGUAGE ? "auto" : picked;
}

/** The decode overrides after a spoken pick: Multiple languages sets `multilingual`; Auto-detect
 *  sends an explicit false only when the layer below would turn it on; a named language drops
 *  the key (the server ignores it once a language is set). */
export function applyMultilingual(
  overrides: DecodeOverrides | undefined,
  picked: string,
  inherited: boolean | undefined,
): DecodeOverrides {
  const next = { ...overrides };
  delete next.multilingual;
  if (picked === MULTI_LANGUAGE) next.multilingual = true;
  else if (picked === "auto" && inherited === true) next.multilingual = false;
  return next;
}

/** A spoken-picker value that names a language — not inherit (""), Auto-detect or
 *  Multiple languages. */
export function namedLanguage(value: string | null | undefined): value is string {
  return !!value && value !== "auto" && value !== MULTI_LANGUAGE;
}

export function spokenLabel(value: string): string {
  return value === MULTI_LANGUAGE ? "Multiple languages" : languageLabel(value);
}

/** A spoken-picker value's label, sanitized and capped; "??" when the joiner-free text is blank
 *  (a set value of only format characters or joiners), as langText gates a code. A real label
 *  renders whole, joiners kept. */
export function spokenText(value: string, max: number): string {
  const s = safeDisplayText(spokenLabel(value), max).trim();
  return langText(s, max).trim() ? s : "??";
}

/** Whether a picker may offer "Multiple languages": the caller may send decode overrides (unknown
 *  counts as yes), the server hasn't locked the key, it is a full backend, and the model can
 *  detect languages at all. */
export function offersMultilingual(args: {
  canOverride: boolean | undefined;
  locked: boolean;
  standard: boolean;
  model: string | null | undefined;
}): boolean {
  return args.canOverride !== false && !args.locked && !args.standard && !isEnglishOnlyModel(args.model);
}

/** A spoken-language field over its decode-overrides layer (Transcribe's run, a Profile, a
 *  Backend): the picker's value, and what a pick stores. `inherited` is what a blank
 *  `multilingual` resolves to below this layer (serverInherited().values). Where the flag isn't
 *  `offered`, this layer's own value is ignored and a pick leaves the overrides alone. */
export function spokenField(
  language: string,
  own: DecodeOverrides | undefined,
  inherited: unknown,
  offered: boolean,
): { value: string; pick: (v: string) => { language: string; overrides: DecodeOverrides | undefined } } {
  const below = typeof inherited === "boolean" ? inherited : undefined;
  return {
    value: spokenValue(language, offered ? own?.multilingual : undefined, below),
    pick: (v) => ({ language: spokenLanguage(v), overrides: offered ? applyMultilingual(own, v, below) : own }),
  };
}
