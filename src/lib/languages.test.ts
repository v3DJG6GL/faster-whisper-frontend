import { describe, expect, it } from "vitest";
import {
  MULTI_LANGUAGE, WHISPER_LANGUAGES, applyMultilingual, isEnglishOnlyModel, langCode, languageLabel, matchesLanguage, namedLanguage, primarySubtag, trackLanguageName,
  nativeName, offersMultilingual, spokenField, spokenLabel, spokenLanguage, spokenSections, spokenValue, targetSections, toggleCode,
} from "./languages";

const values = (rows: { value: string }[]) => rows.map((r) => r.value);

describe("languageLabel", () => {
  it("names Whisper codes, fixing the ones the runtime spells differently", () => {
    expect(languageLabel("de")).toBe("German");
    expect(languageLabel("jw")).toBe("Javanese");
    expect(languageLabel("yue")).toBe("Cantonese");
    expect(languageLabel("bn")).toBe("Bengali");
    expect(languageLabel("zh-Hant")).toBe("Traditional Chinese");
    expect(languageLabel("auto")).toBe("Auto-detect");
  });
  it("names codes outside Whisper's list", () => {
    expect(languageLabel("fil")).toBe("Filipino");
    expect(languageLabel("ug")).toBe("Uyghur");
  });
  it("returns an unknown or malformed code unchanged", () => {
    expect(languageLabel("xx")).toBe("xx");
    expect(languageLabel("not a tag")).toBe("not a tag");
  });
  it("every Whisper language has a real name", () => {
    expect(WHISPER_LANGUAGES).toHaveLength(100);
    for (const c of WHISPER_LANGUAGES) expect(languageLabel(c), c).not.toBe(c);
  });
});

describe("nativeName", () => {
  it("names the language in itself", () => {
    expect(nativeName("de")).toBe("Deutsch");
    expect(nativeName("ja")).toBe("日本語");
  });
  it("is empty when it equals the English name or is no language", () => {
    expect(nativeName("en")).toBe("");
    expect(nativeName("not a tag")).toBe("");
  });
});

describe("matchesLanguage", () => {
  it("matches English name, native name and code", () => {
    expect(matchesLanguage("de", "germ")).toBe(true);
    expect(matchesLanguage("de", "deu")).toBe(true); // Deutsch
    expect(matchesLanguage("de", "DE")).toBe(true);
    expect(matchesLanguage("zh-Hant", "zh")).toBe(true);
  });
  it("matches a code only exactly", () => {
    expect(matchesLanguage("zh", "z")).toBe(false); // a code prefix is not a match
    expect(matchesLanguage("da", "de")).toBe(false);
  });
});

describe("isEnglishOnlyModel", () => {
  it("knows the .en checkpoints", () => {
    expect(isEnglishOnlyModel("small.en")).toBe(true);
    expect(isEnglishOnlyModel("Systran/faster-whisper-medium.en")).toBe(true);
    expect(isEnglishOnlyModel("large-v3")).toBe(false);
    expect(isEnglishOnlyModel(undefined)).toBe(false);
  });
});

describe("spokenSections", () => {
  it("pins the inherit row, Auto-detect and Multiple languages above Recent and the full list", () => {
    const s = spokenSections({ query: "", recent: ["fr", "xx", "de"], inherit: true, multi: true });
    expect(s.map((g) => g.title)).toEqual(["", "Recent", "All languages"]);
    expect(values(s[0].rows)).toEqual(["", "auto", MULTI_LANGUAGE]);
    expect(values(s[1].rows)).toEqual(["fr", "de"]);
    expect(s[2].count).toBe(100);
    expect(s[2].rows[0].value).toBe("af"); // Afrikaans, by name
  });
  it("leaves out what is not offered and an empty Recent", () => {
    const s = spokenSections({ query: "", recent: [] });
    expect(s.map((g) => g.title)).toEqual(["", "All languages"]);
    expect(values(s[0].rows)).toEqual(["auto"]);
  });
  it("shows at most five recents", () => {
    const s = spokenSections({ query: "", recent: ["de", "fr", "it", "es", "pt", "nl"] });
    expect(s[1].rows).toHaveLength(5);
  });
  it("searching shows only the matches", () => {
    const s = spokenSections({ query: "deutsch", recent: ["de"], inherit: true, multi: true });
    expect(s).toEqual([{ title: "Matches", count: 1, rows: [{ value: "de" }] }]);
  });
});

describe("targetSections", () => {
  const supported = ["de", "fr", "zh-Hant"];
  it("groups Recent, the model's languages and the rest, tagging the rest", () => {
    const s = targetSections({ query: "", recent: ["sv", "fr"], supported, modelName: "HY-MT1.5", exclude: "en" });
    expect(s.map((g) => g.title)).toEqual(["Recent", "Supported by HY-MT1.5", "Not officially supported"]);
    expect(s[0].rows).toEqual([{ value: "sv", untested: true }, { value: "fr" }]);
    expect(values(s[1].rows)).toEqual(["fr", "de", "zh-Hant"]);
    expect(s[2].count).toBe(97); // 100 Whisper languages minus de, fr and the source
    expect(values(s[2].rows)).not.toContain("en");
    expect(s[2].rows.every((r) => r.untested)).toBe(true);
  });
  it("offers everything untagged when the model's list is unknown", () => {
    const s = targetSections({ query: "", recent: [], supported: null });
    expect(s.map((g) => g.title)).toEqual(["All languages"]);
    expect(s[0].rows.some((r) => r.untested)).toBe(false);
  });
  it("searching keeps the two groups, untitled by model, and drops Recent", () => {
    const s = targetSections({ query: "chin", recent: ["fr"], supported, modelName: "HY-MT1.5" });
    expect(s.map((g) => g.title)).toEqual(["Supported", "Not officially supported"]);
    expect(values(s[0].rows)).toEqual(["zh-Hant"]);
    expect(values(s[1].rows)).toEqual(["zh"]);
  });
});

describe("toggleCode", () => {
  it("adds, removes, and stops at the cap", () => {
    expect(toggleCode(["de"], "fr", 8)).toEqual(["de", "fr"]);
    expect(toggleCode(["de", "fr"], "de", 8)).toEqual(["fr"]);
    expect(toggleCode(["de"], "fr", 1)).toEqual(["de"]);
  });
});

describe("Multiple languages", () => {
  it("reads auto + multilingual as the Multiple languages row", () => {
    expect(spokenValue("auto", true, undefined)).toBe(MULTI_LANGUAGE);
    expect(spokenValue("auto", undefined, true)).toBe(MULTI_LANGUAGE);
    expect(spokenValue("auto", false, true)).toBe("auto");
    expect(spokenValue("de", true, true)).toBe("de");
    expect(spokenValue("", true, true)).toBe("");
    expect(spokenLabel(MULTI_LANGUAGE)).toBe("Multiple languages");
  });
  it("a pick stores auto + the flag, an explicit off only over an inherited on", () => {
    expect(spokenLanguage(MULTI_LANGUAGE)).toBe("auto");
    expect(applyMultilingual({ beam_size: 5 }, MULTI_LANGUAGE, false)).toEqual({ beam_size: 5, multilingual: true });
    expect(applyMultilingual({ multilingual: true }, "auto", undefined)).toEqual({});
    expect(applyMultilingual(undefined, "auto", true)).toEqual({ multilingual: false });
    expect(applyMultilingual({ multilingual: true }, "de", true)).toEqual({});
  });
  it("is offered only where it can take effect", () => {
    const ok = { canOverride: undefined, locked: false, standard: false, model: "large-v3" };
    expect(offersMultilingual(ok)).toBe(true);
    expect(offersMultilingual({ ...ok, canOverride: false })).toBe(false);
    expect(offersMultilingual({ ...ok, locked: true })).toBe(false);
    expect(offersMultilingual({ ...ok, standard: true })).toBe(false);
    expect(offersMultilingual({ ...ok, model: "small.en" })).toBe(false);
  });
  it("a field reads and writes both layers, and leaves the flag alone where it isn't offered", () => {
    const f = spokenField("auto", { multilingual: true }, false, true);
    expect(f.value).toBe(MULTI_LANGUAGE);
    expect(f.pick("de")).toEqual({ language: "de", overrides: {} });
    const locked = spokenField("auto", { multilingual: true }, false, false);
    expect(locked.value).toBe("auto");
    expect(locked.pick("auto")).toEqual({ language: "auto", overrides: { multilingual: true } });
  });
});

describe("primarySubtag", () => {
  it("the language a code counts for: lowercased, before any - or _", () => {
    expect(["de-CH", "DE_ch", "de-orig", "de", "zh-Hant"].map(primarySubtag)).toEqual(["de", "de", "de", "de", "zh"]);
    expect(primarySubtag(undefined)).toBe("");
    expect(primarySubtag(null)).toBe("");
  });
});

describe("langCode", () => {
  it("bounds, then capitalises; control characters go", () => {
    expect(langCode("pt-BR")).toBe("PT-BR");
    expect(langCode("de\u202e")).toBe("DE");
    expect(langCode("x".repeat(20))).toBe("X".repeat(16));
    expect(langCode("abcdefghij", 8)).toBe("ABCDEFGH");
  });
});

describe("trackLanguageName", () => {
  it("names known codes and keeps a region; an unknown code in caps", () => {
    expect(trackLanguageName("pt-BR")).toBe("Portuguese (BR)");
    expect(trackLanguageName("fi")).toBe("Finnish");
    expect(trackLanguageName("xx")).toBe("XX");
  });
});

describe("namedLanguage", () => {
  it("a code names a language; inherit, Auto-detect and Multiple languages do not", () => {
    expect(["de", "", "auto", MULTI_LANGUAGE, null, undefined].map(namedLanguage)).toEqual([true, false, false, false, false, false]);
  });
});
