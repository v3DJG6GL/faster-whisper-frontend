import { describe, expect, it } from "vitest";
import { backendForAddress, backendLabel, backendLabelById, backendLabels, backendOptions, backendPrompt, backendPromptFields, effectiveLanguage, effectiveOverrideProfile, effectiveServerUrl, effectiveTranslationModel, insecureUrlWarning, fatesAfterSuppliedKey, isStorableServerUrl, newBackendDraft, normalizeUrl, storedTypedUrl, stripUrlNoise, typedServerUrl, authorityOf } from "./backends";
import { NO_OVERRIDE_PROFILE, type AppSettings, type Backend } from "./types";
import { spokenLabel, spokenValue } from "./languages";

describe("newBackendDraft", () => {
  it("a new backend starts on the server's language (W6)", () => {
    expect(newBackendDraft().language).toBe("");
  });
  const models = [
    { id: "large-v3", loaded: false },
    { id: "small", loaded: true }, // another client's pick, not the server default
  ];
  it("a backend added from a full server follows the server's default model", () => {
    const info = { ok: true, openMode: false, models, bootId: "b" };
    expect(newBackendDraft({ serverUrl: "http://h:8000", hasApiKey: false, info }).model).toBe("whisper-1");
  });
  it("a standard server has no default to follow: its loaded model is prefilled", () => {
    const info = { ok: true, openMode: false, models };
    expect(newBackendDraft({ serverUrl: "http://h:8000", hasApiKey: false, info }).model).toBe("small");
  });
});

describe("insecureUrlWarning", () => {
  it("0.0.0.0 (the bind-all address the server prints) never leaves the machine", () => {
    expect(insecureUrlWarning("http://0.0.0.0:8000")).toBeNull();
  });
  it("still warns for plain http to a public address", () => {
    expect(insecureUrlWarning("http://8.8.8.8:8000")).not.toBeNull();
  });
  it("warns for a lenient one-slash http scheme to a public address", () => {
    expect(insecureUrlWarning("http:/8.8.8.8:8000")).not.toBeNull();
  });
  it("warns for a slashless http scheme to a public address", () => {
    expect(insecureUrlWarning("http:example.com")).not.toBeNull();
  });
});

describe("effectiveTranslationModel", () => {
  it("trims both sides; a blank own pick inherits, a blank inherited id is the server default", () => {
    expect(effectiveTranslationModel(" gemma ", "x")).toBe("gemma");
    expect(effectiveTranslationModel("  ", " hy-mt ")).toBe("hy-mt");
    expect(effectiveTranslationModel(undefined, "  ")).toBeUndefined();
    expect(effectiveTranslationModel(undefined, undefined)).toBeUndefined();
  });
});

describe("effectiveLanguage", () => {
  it("a set profile language wins, trimmed", () => {
    expect(effectiveLanguage(" en ", "de")).toBe("en");
  });
  it("blank or absent profile language inherits the backend's", () => {
    expect(effectiveLanguage("   ", "de")).toBe("de");
    expect(effectiveLanguage(undefined, "de")).toBe("de");
    expect(effectiveLanguage("", "de")).toBe("de");
  });
  it("no backend language either → undefined", () => {
    expect(effectiveLanguage(undefined, undefined)).toBeUndefined();
  });
  it("a word naming a Whisper language is its code; auto and codes stay", () => {
    expect(effectiveLanguage("english", "de")).toBe("en");
    expect(effectiveLanguage(undefined, "English")).toBe("en");
    expect(effectiveLanguage("auto", "de")).toBe("auto");
    expect(effectiveLanguage(undefined, "pt-BR")).toBe("pt-BR");
  });
  it("an inherited backend language is trimmed; a whitespace-only one stays as given", () => {
    expect(effectiveLanguage(undefined, " de ")).toBe("de");
    expect(effectiveLanguage(undefined, " english ")).toBe("en");
    expect(effectiveLanguage(undefined, "   ")).toBe("   ");
  });
  it("the Backends editor and list badge label the coded value, not the stored word", () => {
    // Backends.tsx feeds spokenField / spokenValue with effectiveLanguage(undefined, b.language).
    expect(spokenLabel(spokenValue(effectiveLanguage(undefined, "english"), undefined, undefined))).toBe("English");
    expect(spokenLabel(spokenValue(effectiveLanguage(undefined, " de "), undefined, undefined))).toBe("German");
    expect(spokenLabel(spokenValue(effectiveLanguage(undefined, " auto "), true, undefined))).toBe("Multiple languages");
  });
});

describe("backendOptions", () => {
  const be = (id: string, name: string, serverUrl: string): Backend =>
    ({ ...newBackendDraft(), id, name, serverUrl });
  it("a blank or invisible-only name reads 'Untitled backend' with its host, never a bare host", () => {
    const [o] = backendOptions([be("a1b2c3d4e5", "\u2800\u2800", "http://server.lan")]);
    expect(o.label).toBe("Untitled backend \u00b7 server.lan");
    expect(backendOptions([be("a1b2c3d4e5", "", "")])[0].label).toBe("Untitled backend \u00b7 #a1b2c3d4");
  });
  it("two blank backends on one host still get distinct labels", () => {
    const opts = backendOptions([be("aaaaaaaa11", "", "http://server.lan"), be("bbbbbbbb22", "  ", "http://server.lan")]);
    expect(opts[0].label).not.toBe(opts[1].label);
    expect(opts.map((o) => o.label)).toEqual([
      "Untitled backend \u00b7 server.lan \u00b7 #aaaaaaaa",
      "Untitled backend \u00b7 server.lan \u00b7 #bbbbbbbb",
    ]);
  });
  it("a joiner-only name is blank and a leading-joiner look-alike collides with the real name", () => {
    expect(backendOptions([be("a1b2c3d4e5", "\u200d", "http://server.lan")])[0].label).toBe("Untitled backend \u00b7 server.lan");
    const opts = backendOptions([be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", "\u200dWork", "http://b.lan")]);
    expect(opts.map((o) => o.label)).toEqual(["Work \u00b7 a.lan", "Work \u00b7 b.lan"]);
  });
  it("a trailing or interior joiner look-alike collides with the real name too", () => {
    for (const twin of ["Work\u200d", "Wo\u200drk", "Wo\u200crk"]) {
      const opts = backendOptions([be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", twin, "http://b.lan")]);
      expect(opts.map((o) => o.label)).toEqual(["Work \u00b7 a.lan", `${twin} \u00b7 b.lan`]);
    }
  });
  it("a named backend stays bare", () => {
    expect(backendOptions([be("a1b2c3d4e5", "Work", "http://server.lan")])[0].label).toBe("Work");
  });
  it("a joiner hiding the separator still forges no suffix", () => {
    for (const fake of ["Work \u00b7\u200d good.tld", "Work\u200d \u00b7 good.tld"]) {
      const opts = backendOptions([be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", fake, "http://evil.tld")]);
      // The joiner touches whitespace, so the identity fold drops it; the separator left behind forces the real host suffix.
      expect(opts.map((o) => o.label)).toEqual(["Work", "Work \u00b7 good.tld \u00b7 evil.tld"]);
    }
  });
  it("backendLabels maps each id to its picker label, cached per list", () => {
    const all = [be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", "Work", "http://b.lan")];
    const m = backendLabels(all);
    expect([...m.entries()]).toEqual([["aaaaaaaa11", "Work \u00b7 a.lan"], ["bbbbbbbb22", "Work \u00b7 b.lan"]]);
    expect(backendLabels(all)).toBe(m);
    expect(backendLabels([...all])).not.toBe(m);
  });
  it("backendLabel reads the picker label, a backend outside the list its own display name", () => {
    const all = [be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", "Work", "http://b.lan")];
    expect(backendLabel(all, all[1])).toBe("Work \u00b7 b.lan");
    expect(backendLabel(all, be("cccccccc33", "  Gone\u200b ", "http://c.lan"))).toBe("Gone");
    expect(backendLabel([], be("cccccccc33", "", "http://c.lan"))).toBe("Untitled backend");
  });
  it("backendLabelById labels a configured id, null for an unset or gone one", () => {
    const all = [be("aaaaaaaa11", "Work", "http://a.lan"), be("bbbbbbbb22", "Work", "http://b.lan")];
    expect(backendLabelById(all, "bbbbbbbb22")).toBe("Work \u00b7 b.lan");
    expect(backendLabelById(all, "cccccccc33")).toBeNull();
    expect(backendLabelById(all, "")).toBeNull();
    expect(backendLabelById(all, undefined)).toBeNull();
  });
});

describe("effectiveOverrideProfile", () => {
  it("a set own pick wins, trimmed", () => {
    expect(effectiveOverrideProfile(" fast ", "slow")).toBe("fast");
  });
  it("a blank own pick inherits the backend's, trimmed", () => {
    expect(effectiveOverrideProfile("   ", " slow ")).toBe("slow");
    expect(effectiveOverrideProfile(undefined, "slow")).toBe("slow");
  });
  it("a blank backend name is undefined (omit the field)", () => {
    expect(effectiveOverrideProfile("", "   ")).toBeUndefined();
    expect(effectiveOverrideProfile(undefined, undefined)).toBeUndefined();
  });
  it("NO_OVERRIDE_PROFILE passes through verbatim", () => {
    expect(effectiveOverrideProfile(NO_OVERRIDE_PROFILE, "slow")).toBe(NO_OVERRIDE_PROFILE);
    expect(effectiveOverrideProfile(undefined, NO_OVERRIDE_PROFILE)).toBe(NO_OVERRIDE_PROFILE);
  });
});

// The "cleared vs inherited" wire shape: the server reads a PRESENT-but-empty override as
// "cleared — ignore what you would have inherited" and an ABSENT one as "inherit". Collapsing
// the two (`|| undefined`, `!value.trim()`, pruning an empty list) silently brings a cleared
// prompt / glossary / target list back from the server override-profile while the editor
// shows the field empty.

const backend = (over: Partial<Backend> = {}): Backend => ({
  id: "b1",
  name: "Local",
  serverUrl: "http://localhost:8000",
  hasApiKey: false,
  model: "large-v3",
  endpoint: "stream",
  language: "auto",
  prompt: "",
  responseFormat: "verbose_json",
  ...over,
});

describe("backendPrompt — the Backend default's tri-state", () => {
  it("reads unset as inherit and cleared as an explicit empty", () => {
    // Both store `prompt: ""`; only the flag says whether the server's DEFAULT_PROMPT applies.
    expect(backendPrompt(backend())).toBeUndefined();
    expect(backendPrompt(backend({ promptCleared: true }))).toBe("");
  });

  it("reads a set prompt verbatim, flag or no flag", () => {
    expect(backendPrompt(backend({ prompt: "ACME, Kubernetes" }))).toBe("ACME, Kubernetes");
    // A stale flag under a re-typed prompt must not turn a real value into a clear.
    expect(backendPrompt(backend({ prompt: "ACME", promptCleared: true }))).toBe("ACME");
  });

  it("round-trips every state through the editor's writer", () => {
    for (const v of [undefined, "", "bias terms"]) {
      expect(backendPrompt({ ...backend(), ...backendPromptFields(v) })).toBe(v);
    }
  });

  it("drops the flag on reset, so the stale one cannot survive a spread", () => {
    // `set()` spreads a partial onto the draft — writing only `prompt` would leave a
    // previous clear's flag behind and re-clear a field the user had just reset.
    expect(backendPromptFields(undefined).promptCleared).toBeUndefined();
    expect(backendPromptFields("x").promptCleared).toBeUndefined();
    expect(backendPromptFields("").promptCleared).toBe(true);
  });

  it("keeps an UNSET prompt storable as a plain empty string", () => {
    // Deliberate: `Backend.prompt` stays a required string on disk so a config written
    // here still parses in an older build (which would otherwise back the whole config
    // up to .bak and load defaults — a downgrade wiping every backend and hotkey).
    expect(backendPromptFields(undefined).prompt).toBe("");
    expect(backendPromptFields("").prompt).toBe("");
  });
});

describe("storedTypedUrl", () => {
  it("gives a schemeless LAN address the http:// the transport needs", () => {
    expect(storedTypedUrl("host:8000")).toBe("http://host:8000");
    expect(storedTypedUrl("  192.168.1.5:8000 ")).toBe("http://192.168.1.5:8000");
  });
  it("keeps an http(s) URL as typed, a blank field blank and an unsupported scheme verbatim", () => {
    expect(storedTypedUrl("https://h/")).toBe("https://h/");
    expect(storedTypedUrl("")).toBe("");
    expect(storedTypedUrl("ftp://x")).toBe("ftp://x");
  });
  it("canonicalises a lenient http(s) scheme the parsers would honour", () => {
    expect(storedTypedUrl("http:/h.example:8000")).toBe("http://h.example:8000");
    expect(storedTypedUrl("HTTPS:\\\\h")).toBe("https://h");
  });
  it("keeps host:port meaning for a slashless `http:8000`", () => {
    expect(storedTypedUrl("http:8000")).toBe("http://http:8000");
  });
  it("canonicalises a slashless http(s) scheme whose remainder is a host", () => {
    // WHATWG and the url crate read `http:evil.tld:8000` as http://evil.tld:8000/.
    expect(storedTypedUrl("http:evil.tld:8000")).toBe("http://evil.tld:8000");
    expect(storedTypedUrl("HTTPS:example.com")).toBe("https://example.com");
  });
});

describe("typedServerUrl", () => {
  it("is the stored form, normalised", () => {
    expect(typedServerUrl(" host:8000 ")).toBe(normalizeUrl("http://host:8000"));
    expect(typedServerUrl("http:/h/")).toBe("http://h");
    expect(typedServerUrl("ftp://x")).toBe("");
  });
});

describe("effectiveServerUrl", () => {
  const b = { ...newBackendDraft(), id: "b1", serverUrl: "http://canonical:8000" };
  const withOverride = (v: string) => ({ sync: { urlOverrides: { b1: v } } }) as unknown as AppSettings;
  it("gives a schemeless per-device override the http:// the transport needs", () => {
    expect(effectiveServerUrl(b, withOverride("192.168.1.5:8000"))).toBe("http://192.168.1.5:8000");
  });
  it("keeps an https override as typed and falls back to serverUrl for a blank one", () => {
    expect(effectiveServerUrl(b, withOverride("https://x"))).toBe("https://x");
    expect(effectiveServerUrl(b, withOverride("   "))).toBe("http://canonical:8000");
  });
  it("gives a slashless http: override the // the parsers read into it", () => {
    expect(effectiveServerUrl(b, withOverride("http:example.com"))).toBe("http://example.com");
  });
});

describe("stripUrlNoise trims the edges the Rust transport trims (str::trim)", () => {
  // [raw, stripped, authority host (null = unparseable)]. U+00A0, U+2028 and U+3000 are
  // White_Space, which Rust trims before it connects. U+FEFF is not: Rust keeps it, and so does
  // this (neither side then reads a scheme).
  const matrix: [string, string, string | null][] = [
    ["http://h.tld\u00a0", "http://h.tld", "h.tld"],
    ["\u00a0http://h.tld", "http://h.tld", "h.tld"],
    ["http://h.tld\u2028", "http://h.tld", "h.tld"],
    ["\u2028http://h.tld", "http://h.tld", "h.tld"],
    ["http://h.tld\u3000", "http://h.tld", "h.tld"],
    ["\u3000http://h.tld", "http://h.tld", "h.tld"],
    ["\u00a0localhost:8000", "localhost:8000", "localhost:8000"],
    ["http://h.tld\ufeff", "http://h.tld\ufeff", "h.tld"],
    ["\ufeffhttp://h.tld", "\ufeffhttp://h.tld", "http"],
    ["http://h.tld\t", "http://h.tld", "h.tld"],
    ["\thttp://h.tld", "http://h.tld", "h.tld"],
    ["http://h.tld\u0000", "http://h.tld", "h.tld"],
    ["\u0000http://h.tld", "http://h.tld", "h.tld"],
    ["http://h\u00a0x.tld", "http://h\u00a0x.tld", null],
    ["https://gpu.example.com", "https://gpu.example.com", "gpu.example.com"],
  ];
  it("strips, parses and stores as the transport connects", () => {
    for (const [raw, stripped, host] of matrix) {
      expect([raw, stripUrlNoise(raw)]).toEqual([raw, stripped]);
      expect([raw, authorityOf(raw)?.host ?? null]).toEqual([raw, host]);
      expect([raw, isStorableServerUrl(raw)]).toEqual([raw, true]);
    }
  });
  it("a synced 'user@host' redirect behind a trailing NBSP shows its real host and the warning", () => {
    const synced = "http://localhost:8000@evil.tld\u00a0";
    expect(authorityOf(synced)).toEqual({ host: "evil.tld", hasUserinfo: true });
    expect(insecureUrlWarning(synced)).not.toBeNull();
  });
});

// The connect-first restore writes the key the user just typed into the restored backend for
// the server it connected to, so the dialog must not tell them that backend needs one.
describe("fatesAfterSuppliedKey — the restore dialog's keyless list", () => {
  const missingAfterSuppliedKey = (missing: Backend[], installed: Backend[], keyFor?: string) =>
    fatesAfterSuppliedKey({ missing, moved: [] }, installed, keyFor).missing;
  const home = backend({ id: "home", name: "Home server", serverUrl: "home.lan:8000/", hasApiKey: true });
  const work = backend({ id: "work", name: "Work", serverUrl: "https://work.example", hasApiKey: true });
  it("drops the backend the supplied key lands on (normalized address match), keeps the others", () => {
    expect(missingAfterSuppliedKey([home, work], [home, work], " http://home.lan:8000")).toEqual([work]);
  });
  it("no supplied address, or one no installed backend serves → unchanged", () => {
    expect(missingAfterSuppliedKey([home, work], [home, work], undefined)).toEqual([home, work]);
    expect(missingAfterSuppliedKey([home, work], [home, work], "http://elsewhere:8000")).toEqual([home, work]);
  });
  it("only the backend finishRestore picks (the first match) loses the warning", () => {
    const twin = backend({ id: "twin", name: "Twin", serverUrl: "http://home.lan:8000", hasApiKey: true });
    expect(missingAfterSuppliedKey([home, twin], [home, twin], "home.lan:8000")).toEqual([twin]);
    expect(backendForAddress([home, twin], "home.lan:8000")?.id).toBe("home");
  });
});
