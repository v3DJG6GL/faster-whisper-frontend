import { describe, expect, it } from "vitest";
import { backendOptions, backendPrompt, backendPromptFields, effectiveLanguage, effectiveOverrideProfile, effectiveServerUrl, effectiveTranslationModel, insecureUrlWarning, newBackendDraft, normalizeUrl, storedTypedUrl, typedServerUrl } from "./backends";
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
  it("a named backend stays bare", () => {
    expect(backendOptions([be("a1b2c3d4e5", "Work", "http://server.lan")])[0].label).toBe("Work");
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

// The "cleared vs inherited" wire shape.
//
// The server now reads a PRESENT-but-empty override as "cleared — ignore what you would
// have inherited", and an ABSENT one as "inherit". Everywhere the client used to collapse
// the two (`|| undefined`, `!value.trim()`, "prune the empty list") it lost the user's
// ability to say *no* — the cleared prompt / glossary / target list came back from the
// server override-profile, silently, with the field still showing empty in the editor.
//
// These pin the three states for each field the client can now express.

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
    // The pair that used to be one value: both store `prompt: ""`, and only the flag
    // says whether the server's DEFAULT_PROMPT applies.
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
    // previous clear's flag behind and re-cleared a field the user had just reset.
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
