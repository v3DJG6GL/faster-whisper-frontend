import { describe, expect, it } from "vitest";
import { cleanRecent, pushRecent } from "./recent";

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
