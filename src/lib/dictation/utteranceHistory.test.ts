import { describe, expect, it } from "vitest";
import { appendChunk, appendDelta, finalDelta, mergeTracks } from "./utteranceHistory";

describe("finalDelta", () => {
  it("is what the document gained since the previous final", () => {
    const one = " Hallo Welt";
    expect(finalDelta(one, 0)).toBe(" Hallo Welt");
    const two = `${one} und weiter`;
    expect(finalDelta(two, one.length)).toBe(" und weiter");
  });

  it("adds nothing for a re-sent final or a document that shrank", () => {
    expect(finalDelta(" Hallo", 6)).toBe("");
    expect(finalDelta(" Hallo", 20)).toBe("");
  });
});

describe("appendDelta", () => {
  it("keeps the delta's own seam", () => {
    expect(appendDelta("Hallo Welt", " Komma")).toBe("Hallo Welt Komma");
    expect(appendDelta("Hallo Welt", ",")).toBe("Hallo Welt,");
    expect(appendDelta("", " Hallo")).toBe("Hallo");
  });
});

describe("appendChunk / mergeTracks", () => {
  it("joins a later chunk with one space", () => {
    expect(appendChunk(undefined, " Hello ")).toBe("Hello");
    expect(appendChunk("Hello world", "comma")).toBe("Hello world comma");
  });

  it("merges per language and ignores empty chunks", () => {
    expect(mergeTracks(undefined, { en: "Hello" })).toEqual({ en: "Hello" });
    expect(mergeTracks({ en: "Hello", fr: "Bonjour" }, { en: "world", fr: " " })).toEqual({
      en: "Hello world",
      fr: "Bonjour",
    });
    expect(mergeTracks({ en: "Hello" }, undefined)).toEqual({ en: "Hello" });
    expect(mergeTracks(undefined, { en: "" })).toBeUndefined();
  });

  it("takes a language code spelled like an inherited member", () => {
    expect(mergeTracks(undefined, { constructor: "x" })?.constructor).toBe("x");
  });
});
