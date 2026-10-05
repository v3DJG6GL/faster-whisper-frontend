import { describe, expect, it } from "vitest";
import { cleanRecent, pushRecent, rememberRecent } from "./recent";
import { useApp } from "./store";

describe("pushRecent", () => {
  it("puts the new picks first, de-duplicated and capped", () => {
    expect(pushRecent(["de", "fr", "it"], ["it", "es"])).toEqual(["it", "es", "de", "fr"]);
    expect(pushRecent(undefined, ["de", "de"])).toEqual(["de"]);
    expect(pushRecent(["a", "b", "c"], ["d"], 2)).toEqual(["d", "a"]);
  });
});

describe("cleanRecent", () => {
  it("keeps sane strings only", () => {
    expect(cleanRecent(["de", 1, "", "x".repeat(65), "de", "fr"])).toEqual(["de", "fr"]);
    expect(cleanRecent("de")).toEqual([]);
  });
});

describe("rememberRecent", () => {
  it("cleans the stored list before adding the picks; nothing picked = nothing written", () => {
    const st = useApp.getState();
    st.updateSettings({ recentTranslationTargets: ["fr", 7, "fr", "x".repeat(99)] as unknown as string[] });
    rememberRecent("recentTranslationTargets", ["de", "en"]);
    expect(useApp.getState().settings.recentTranslationTargets).toEqual(["de", "en", "fr"]);
    const before = useApp.getState().settings;
    rememberRecent("recentTranslationTargets", []);
    expect(useApp.getState().settings).toBe(before);
  });
});
