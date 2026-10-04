import { describe, expect, it } from "vitest";
import { inheritLabel, onOff, serverInherited } from "./inherit";
import type { DecodeDefault, DecodeDefaults } from "./types";

describe("inheritLabel", () => {
  it("names the inherited value after the word", () => {
    expect(inheritLabel("on")).toBe("Inherit · on");
    expect(inheritLabel("large-v3", "Default")).toBe("Default · large-v3");
  });
  it("falls back to the bare word when the value is unknown", () => {
    expect(inheritLabel(undefined)).toBe("Inherit");
    expect(inheritLabel("  ", "Default")).toBe("Default");
    expect(inheritLabel(null)).toBe("Inherit");
  });
  it("maps booleans to on/off", () => {
    expect(onOff(true)).toBe("on");
    expect(onOff(false)).toBe("off");
    expect(onOff(undefined)).toBeUndefined();
  });
});

function dd(over: Partial<DecodeDefaults> = {}): DecodeDefaults {
  const entry = (value: DecodeDefault["value"], extra: Partial<DecodeDefault> = {}): DecodeDefault => ({
    value,
    source: "server",
    label: "global default",
    locked: false,
    ...extra,
  });
  return {
    model: "Systran/faster-whisper-large-v3",
    profile_applied: null,
    settings: {
      beam_size: entry(10, { source: "model", label: "per-model · large-v3" }),
      best_of: entry(5),
      temperature: entry("0.0,0.2,0.4"),
      condition_on_previous_text: entry(true),
      vad_filter: entry("false"),
      hotwords: entry(null, { source: "builtin" }),
      no_speech_threshold: entry(null, { source: "builtin" }),
      patience: entry(1, { locked: true }),
      multilingual: entry(false, { locked: true }),
    } as DecodeDefaults["settings"],
    prompt: entry("Medizin", { source: "account", label: "user · profile studio", locked: true }),
    streaming: { condition_on_previous_text: { final: false, partial: false, pinned: true }, best_of: { value: 1 } },
    ...over,
  };
}

describe("serverInherited", () => {
  it("shows the server's values with their source", () => {
    const s = serverInherited(dd());
    expect(s.values.beam_size).toBe(10);
    expect(s.sources.beam_size).toBe("Server default for faster-whisper-large-v3 (model config)");
    expect(s.values.temperature).toBe("0.0,0.2,0.4");
    expect(s.values.hotwords).toBe("none");
    expect(s.values.no_speech_threshold).toBe("off");
    expect(s.sources.hotwords).toBe("faster-whisper's built-in default");
  });
  it("takes only real booleans for on/off keys", () => {
    expect(serverInherited(dd()).values.vad_filter).toBeUndefined();
    expect(serverInherited(dd()).values.condition_on_previous_text).toBe(true);
    expect(serverInherited(dd()).values.multilingual).toBe(false);
    expect(serverInherited(dd()).locked.has("multilingual")).toBe(true);
  });
  it("lets the backend beat the server, except where the server locks", () => {
    const s = serverInherited(dd(), { beam_size: 3, patience: 2 }, "batch", "Backend default");
    expect(s.values.beam_size).toBe(3);
    expect(s.sources.beam_size).toBe("Backend default");
    expect(s.values.patience).toBe(1);
    expect(s.locked.has("patience")).toBe(true);
    expect(s.ignored).toEqual(["patience"]);
  });
  it("uses live dictation's best_of and pin in stream mode", () => {
    const batch = serverInherited(dd());
    expect(batch.values.best_of).toBe(5);
    expect(batch.pinned.condition_on_previous_text).toBeUndefined();
    const stream = serverInherited(dd(), undefined, "stream");
    expect(stream.values.best_of).toBe(1);
    expect(stream.pinned.condition_on_previous_text?.value).toBe("off");
    // A backend best_of still wins in dictation.
    expect(serverInherited(dd(), { best_of: 4 }, "stream").values.best_of).toBe(4);
  });
  it("carries the prompt and its lock", () => {
    const p = serverInherited(dd()).prompt!;
    expect(p.value).toBe("Medizin");
    expect(p.locked).toBe(true);
    expect(p.source).toBe("Set for your account on the server (user · profile studio)");
    expect(serverInherited(dd({ prompt: { value: null, source: "server", label: "", locked: false } })).prompt?.value).toBeUndefined();
  });
  it("is empty without server data", () => {
    const s = serverInherited(null, { beam_size: 2 });
    expect(s.values).toEqual({ beam_size: 2 });
    expect(s.prompt).toBeUndefined();
  });
});
