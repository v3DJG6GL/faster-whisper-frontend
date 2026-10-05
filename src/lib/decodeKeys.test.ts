import { beforeEach, describe, expect, it } from "vitest";
import {
  BOOL_KEYS,
  clampDecodeOverrides,
  countSet,
  DECODE_KEY_LIST,
  DECODE_KEYS,
  keySpec,
  LIVE_KEYS,
  NULL_TEXT,
  DECODE_SECTIONS,
  parseLadderInput,
  sanitizeDecodeValue,
  sectionKeys,
  TYPED_TEXT_KEYS,
  type DecodeKey,
} from "./decodeKeys";

import {
  applyBlob,
  approvePendingReview,
  categorySelection,
  clampTranslationOverrides,
  composeBlob,
  getPendingReview,
  raiseConflictForTests,
  resolveSyncConflicts,
  sanitizeBackends,
  sanitizeProfiles,
  securityChanges,
} from "./sync";
import { useApp } from "./store";
import { DEFAULT_SETTINGS } from "./defaults";
import { DEFAULT_SETTING_SYNC } from "./settingsManifest";
import type { Backend, DecodeOverrides, Profile } from "./types";

/** The `settings` keys of GET /v1/request-default-settings, recorded from the frozen settings
 *  batch contract (2026-10-05): the server lists every client key its registry has. This list
 *  replaces the old Rust "a renamed key fails a test" guard — the Rust mirror is a map now. */
const SERVER_CLIENT_KEYS = [
  "beam_size", "best_of", "vad_filter", "vad_min_silence_duration_ms", "vad_speech_pad_ms",
  "vad_threshold", "condition_on_previous_text", "no_speech_threshold", "log_prob_threshold",
  "compression_ratio_threshold", "hotwords", "temperature", "patience", "length_penalty",
  "repetition_penalty", "no_repeat_ngram_size", "multilingual", "suppress_tokens",
  "prepend_punctuations", "append_punctuations",
  "streaming_vad_threshold", "streaming_vad_inner_silence_ms", "streaming_vad_outer_silence_ms",
  "streaming_hard_break_silence_ms", "streaming_hard_break_separator",
  "hallucination_silence_threshold", "suppress_chars", "language_detection_segments",
  "language_detection_threshold", "output_prefix", "output_suffix",
];

/** One in-range value per key, as an editor would store it. The sync round-trip tests below
 *  use it too: every key must come back from every sanitizer exactly as it went in. */
function sampleOverrides(): Required<DecodeOverrides> {
  const out: Record<string, unknown> = {};
  for (const k of DECODE_KEY_LIST) {
    const s = keySpec(k);
    if (s.kind === "bool") out[k] = true;
    else if (s.kind === "ladder") out[k] = "0.0,0.4,0.8";
    else if (s.kind === "text") out[k] = s.multiline ? "\n" : `${k} ¶`;
    else out[k] = s.kind === "int" ? Math.round(((s.min ?? 0) + (s.max ?? 10)) / 2) : ((s.min ?? 0) + (s.max ?? 1)) / 2;
  }
  return out as Required<DecodeOverrides>;
}

describe("DECODE_KEYS", () => {
  it("names exactly the client keys the server lists", () => {
    expect([...DECODE_KEY_LIST].sort()).toEqual([...SERVER_CLIENT_KEYS].sort());
  });

  it("live keys are exactly the streaming_ ones (the batch strip's rule)", () => {
    expect([...LIVE_KEYS].sort()).toEqual(DECODE_KEY_LIST.filter((k) => k.startsWith("streaming_")).sort());
    for (const k of LIVE_KEYS) expect(keySpec(k).section).toBe("live");
  });

  it("derives the bool, null-text and typed-text sets from the table", () => {
    expect([...BOOL_KEYS].sort()).toEqual(["condition_on_previous_text", "multilingual", "vad_filter"]);
    expect(NULL_TEXT).toMatchObject({ hotwords: "none", no_speech_threshold: "off", hallucination_silence_threshold: "off" });
    expect([...TYPED_TEXT_KEYS].sort()).toEqual(["output_prefix", "output_suffix", "streaming_hard_break_separator"]);
  });

  it("every numeric key has bounds and every text key a length cap", () => {
    for (const k of DECODE_KEY_LIST) {
      const s = keySpec(k);
      if (s.kind === "int" || s.kind === "float" || s.kind === "ladder") {
        expect(s.min, k).toBeTypeOf("number");
        expect(s.max, k).toBeTypeOf("number");
      }
      if (s.kind === "text" || s.kind === "ladder") expect(s.maxLen, k).toBeTypeOf("number");
      expect(s.env, k).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });
});

describe("clampDecodeOverrides", () => {
  it("keeps every in-range value exactly", () => {
    const s = sampleOverrides();
    expect(clampDecodeOverrides(s)).toEqual(s);
  });

  it("an explicit empty text and the separator's newline survive", () => {
    const out = clampDecodeOverrides({
      output_prefix: "",
      suppress_chars: "",
      hotwords: "",
      streaming_hard_break_separator: "\n",
    });
    expect(out).toEqual({ output_prefix: "", suppress_chars: "", hotwords: "", streaming_hard_break_separator: "\n" });
  });

  it("numbers clamp to the contract's bounds; ints round", () => {
    const out = clampDecodeOverrides({
      beam_size: 99,
      best_of: 0,
      vad_threshold: -1,
      log_prob_threshold: 5,
      streaming_vad_outer_silence_ms: 10,
      streaming_hard_break_silence_ms: 999_999,
      streaming_vad_inner_silence_ms: 712.6,
      hallucination_silence_threshold: 61,
      language_detection_segments: 0,
      language_detection_threshold: 2,
      temperature: 3,
    });
    expect(out).toEqual({
      beam_size: 20,
      best_of: 1,
      vad_threshold: 0,
      log_prob_threshold: 0,
      streaming_vad_outer_silence_ms: 100,
      streaming_hard_break_silence_ms: 120000,
      streaming_vad_inner_silence_ms: 713,
      hallucination_silence_threshold: 60,
      language_detection_segments: 1,
      language_detection_threshold: 1,
      temperature: 1,
    });
  });

  it("text is capped to the server's length, controls go except a multiline newline", () => {
    const out = clampDecodeOverrides({
      streaming_hard_break_separator: "\n\n\r\t--- way too long",
      output_prefix: "a\nb\u0007c" + "x".repeat(600),
      hotwords: "h".repeat(3000),
    })!;
    expect(out.streaming_hard_break_separator).toBe("\n\n--- wa");
    expect(out.output_prefix).toHaveLength(512);
    expect(out.output_prefix!.startsWith("abcxx")).toBe(true);
    expect(out.hotwords).toHaveLength(2048);
  });

  it("a temperature ladder is kept verbatim when valid, clamped when not, dropped when unreadable", () => {
    expect(sanitizeDecodeValue("temperature", "0.0,0.2,0.4")).toBe("0.0,0.2,0.4");
    expect(sanitizeDecodeValue("temperature", "0.5")).toBe("0.5");
    expect(sanitizeDecodeValue("temperature", "0,1.5")).toBe("0,1");
    expect(sanitizeDecodeValue("temperature", Array(20).fill("0").join(","))).toBe(Array(16).fill("0").join(","));
    expect(sanitizeDecodeValue("temperature", "0,x")).toBeUndefined();
    expect(sanitizeDecodeValue("temperature", "0,,1")).toBeUndefined();
    expect(sanitizeDecodeValue("temperature", "")).toBeUndefined();
    expect(sanitizeDecodeValue("temperature", 0.3)).toBe(0.3);
  });

  it("wrong types are dropped; a newer peer's numeric key passes, its text does not", () => {
    const out = clampDecodeOverrides({
      beam_size: "5",
      vad_filter: "yes",
      hotwords: 3,
      streaming_vad_threshold: Number.NaN,
      future_knob: 4,
      future_flag: false,
      future_text: "typed",
      "Bad Key": 1,
      nested: {},
    });
    expect(out).toEqual({ future_knob: 4, future_flag: false });
    expect(clampDecodeOverrides("abc")).toBeUndefined();
    expect(clampDecodeOverrides([1])).toBeUndefined();
  });
});

describe("countSet", () => {
  it("counts the decode block and the live block apart", () => {
    const ov: DecodeOverrides = {
      beam_size: 5,
      output_prefix: "",
      multilingual: true, // the language picker's, in neither block
      streaming_vad_threshold: 0.4,
      streaming_hard_break_separator: "\n",
    };
    expect(countSet(ov, "decode")).toBe(2);
    expect(countSet(ov, "live")).toBe(2);
    expect(countSet(undefined, "decode")).toBe(0);
  });
});

it("the table is keyed by the DecodeOverrides keys (compile-time check, mirrored at runtime)", () => {
  const key: DecodeKey = "streaming_hard_break_separator";
  expect(DECODE_KEYS[key].multiline).toBe(true);
});

// ── settings sync: every key survives push/pull and export/import ───────────

const CATS_ALL = categorySelection(true);

function backend(over: Partial<Backend> = {}): Backend {
  return {
    id: "b1",
    name: "local",
    serverUrl: "http://10.0.0.2:8000",
    hasApiKey: false,
    model: "large-v3",
    endpoint: "stream",
    language: "auto",
    prompt: "",
    responseFormat: "verbose_json",
    ...over,
  };
}

function profile(over: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Default",
    activation: "hold",
    enabled: true,
    hotkey: ["ControlLeft", "Space"],
    backendId: "b1",
    ...over,
  };
}

function reset(over: { backends?: Backend[]; profiles?: Profile[] } = {}) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.sync = { ...settings.sync!, sub: { ...DEFAULT_SETTING_SYNC, recordingsDir: DEFAULT_SETTING_SYNC.audioFolder } };
  useApp.setState({
    settings,
    backends: over.backends ?? [backend()],
    profiles: over.profiles ?? [profile()],
    appRules: [],
    status: "idle",
  });
}

describe("decode keys through settings sync", () => {
  beforeEach(() => reset());

  it("every key round-trips sanitizeProfiles and sanitizeBackends", () => {
    const ov = sampleOverrides();
    const [p] = sanitizeProfiles([profile({ decodeOverrides: ov })]);
    const [b] = sanitizeBackends([backend({ decodeOverrides: ov })]);
    expect(p.decodeOverrides).toEqual(ov);
    expect(b.decodeOverrides).toEqual(ov);
  });

  it("every key round-trips composeBlob → applyBlob (push → pull)", async () => {
    const ov = sampleOverrides();
    reset({ backends: [backend({ decodeOverrides: ov })], profiles: [profile({ decodeOverrides: ov })] });
    const s = useApp.getState();
    const blob = await composeBlob(
      { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
      CATS_ALL,
      undefined,
      { includeSecrets: false, sub: s.settings.sync!.sub!, gates: { ...DEFAULT_SETTING_SYNC } },
    );
    // Through the wire as JSON, like the server blob and the export file.
    const wire = JSON.parse(JSON.stringify(blob));
    reset({ backends: [backend()], profiles: [profile()] });
    expect(await applyBlob(wire, CATS_ALL)).toBe(true);
    expect(useApp.getState().profiles[0].decodeOverrides).toEqual(ov);
    expect(useApp.getState().backends[0].decodeOverrides).toEqual(ov);
  });

  it("every key round-trips an export file → import (gates ignored)", async () => {
    const ov = { ...sampleOverrides(), output_prefix: "", streaming_hard_break_separator: "\n" };
    reset({ backends: [backend({ decodeOverrides: ov })], profiles: [profile({ decodeOverrides: ov })] });
    const s = useApp.getState();
    const blob = await composeBlob(
      { settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules },
      CATS_ALL,
      undefined,
      { includeSecrets: false, sub: s.settings.sync!.sub! },
    );
    const file = JSON.parse(JSON.stringify(blob));
    reset({ backends: [], profiles: [] });
    expect(await applyBlob(file, CATS_ALL, 2, { ignoreGates: true })).toBe(true);
    expect(useApp.getState().profiles[0].decodeOverrides).toEqual(ov);
    expect(useApp.getState().backends[0].decodeOverrides).toEqual(ov);
  });

  it("an out-of-range inbound value is clamped, not dropped and not kept", async () => {
    await applyBlob(
      { profiles: { list: [profile({ decodeOverrides: { streaming_vad_outer_silence_ms: 50, beam_size: 2.6 } })] } } as never,
      { ...CATS_ALL, backends: false },
    );
    expect(useApp.getState().profiles[0].decodeOverrides).toEqual({ streaming_vad_outer_silence_ms: 100, beam_size: 3 });
  });
});

describe("translation overrides through settings sync", () => {
  it("contextSegments is an integer 0–10; targets are capped at TRANSLATION_MAX_TARGETS", () => {
    expect(clampTranslationOverrides({ contextSegments: 2.5 })?.contextSegments).toBe(3);
    expect(clampTranslationOverrides({ contextSegments: -1 })?.contextSegments).toBe(0);
    expect(clampTranslationOverrides({ contextSegments: 99 })?.contextSegments).toBe(10);
    expect(clampTranslationOverrides({ contextSegments: "3" })?.contextSegments).toBeUndefined();
    const ten = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(clampTranslationOverrides({ translateTo: ten })?.translateTo).toHaveLength(8);
    expect(clampTranslationOverrides([1])).toBeUndefined();
  });

  it("profiles and backends share the one clamp", () => {
    const t = { translateTo: ["de"], contextSegments: 4.4, glossary: "a = b", mode: "fluent", includeOriginal: true };
    const [p] = sanitizeProfiles([profile({ translationOverrides: t as never })]);
    const [b] = sanitizeBackends([backend({ translationOverrides: t as never })]);
    expect(p.translationOverrides).toEqual({ ...t, contextSegments: 4 });
    expect(b.translationOverrides).toEqual(p.translationOverrides);
  });
});

describe("typed-text security review", () => {
  beforeEach(() => reset());

  const local = () => ({
    profiles: { list: [profile({ decodeOverrides: { output_prefix: "> " } })] },
    backends: { list: [backend()], secrets: {} },
  });

  it("an inbound separator, prefix or suffix change is held for approval", () => {
    const incoming = {
      profiles: { list: [profile({ decodeOverrides: { output_prefix: "rm -rf ~", streaming_hard_break_separator: "\n" } })] },
      backends: { list: [backend({ decodeOverrides: { output_suffix: "\u0007!" } })], secrets: {} },
    };
    const changes = securityChanges(incoming as never, local() as never, CATS_ALL);
    expect(changes.filter((c) => c.kind === "typed-text").map((c) => [c.category, c.detail])).toEqual([
      ["profiles", 'OUTPUT_PREFIX would type "rm -rf ~"'],
      ["profiles", 'STREAMING_HARD_BREAK_SEPARATOR would type "\\n"'],
      ["backends", 'OUTPUT_SUFFIX would type "!"'],
    ]);
  });

  it("an unchanged, cleared or removed value types nothing new and raises nothing", () => {
    for (const ov of [{ output_prefix: "> " }, { output_prefix: "" }, {}]) {
      const incoming = { profiles: { list: [profile({ decodeOverrides: ov })] } };
      expect(securityChanges(incoming as never, local() as never, CATS_ALL)).toEqual([]);
    }
  });

  it("a backend's text raises nothing while its decode defaults don't sync", () => {
    const incoming = { backends: { list: [backend({ decodeOverrides: { output_prefix: "x" } })], secrets: {} } };
    expect(securityChanges(incoming as never, local() as never, CATS_ALL, { modelDecodeDefaults: false })).toEqual([]);
    expect(securityChanges(incoming as never, local() as never, CATS_ALL)).toHaveLength(1);
  });

  it("a held change waits, the rest applies, and approving lands it", async () => {
    reset({ profiles: [profile({ name: "Mail", decodeOverrides: { output_prefix: "> " } })] });
    const remote = {
      profiles: { list: [profile({ name: "Mail", decodeOverrides: { output_prefix: ">> ", streaming_hard_break_separator: "\n" } })] },
    };
    raiseConflictForTests({ categories: ["profiles"], local: {}, remote: remote as never, merged: {} });
    await resolveSyncConflicts({ profiles: "remote" });
    expect(getPendingReview()?.changes.map((c) => c.kind)).toEqual(["typed-text", "typed-text"]);
    expect(useApp.getState().profiles[0].decodeOverrides).toEqual({ output_prefix: "> " });
    await approvePendingReview();
    expect(getPendingReview()).toBeNull();
    expect(useApp.getState().profiles[0].decodeOverrides).toEqual({
      output_prefix: ">> ",
      streaming_hard_break_separator: "\n",
    });
  });
});

describe("decode editor rows", () => {
  it("every row key sits in the primary rows or one shown section", () => {
    const shown = ["primary", ...DECODE_SECTIONS.map((s) => s.id)];
    const rows = shown.flatMap((s) => sectionKeys(s as Parameters<typeof sectionKeys>[0]));
    // Live keys have their own block, multilingual rides the language picker.
    expect(rows.sort()).toEqual(DECODE_KEY_LIST.filter((k) => !LIVE_KEYS.has(k) && k !== "multilingual").sort());
  });
  it("orders the sections as the mockup does, language detection last", () => {
    expect(DECODE_SECTIONS.map((s) => s.id)).toEqual(["vad", "thresholds", "sampling", "vocab", "langdetect"]);
    expect(sectionKeys("thresholds")[0]).toBe("hallucination_silence_threshold");
  });
});

describe("parseLadderInput", () => {
  it("empty inherits", () => {
    expect(parseLadderInput("  ", false)).toBeUndefined();
  });
  it("one plain rung is a number", () => {
    expect(parseLadderInput("0.2", false)).toBe(0.2);
    expect(parseLadderInput("1", true)).toBe(1);
  });
  it("a ladder or a half-typed rung stays text", () => {
    expect(parseLadderInput("0.0,0.4", false)).toBe("0.0,0.4");
    expect(parseLadderInput("0.", false)).toBe("0.");
    expect(parseLadderInput("0.20", true)).toBe("0.20");
  });
  it("refuses letters, and a ladder on a standard server", () => {
    expect(parseLadderInput("0.2x", false)).toBeNull();
    expect(parseLadderInput("0,0.2", true)).toBeNull();
  });
});
