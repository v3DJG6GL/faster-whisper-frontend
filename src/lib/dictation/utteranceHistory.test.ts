import { describe, expect, it } from "vitest";
import { appendChunk, appendDelta, appendTranslation, finalDelta, mergeTracks, routeUtteranceClip, type UtteranceClip, type UtteranceEntry } from "./utteranceHistory";

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

describe("appendTranslation", () => {
  // A hands-free session typed an utterance's ordinal final, then the server's release final
  // handed it the held-back word. The record's text is what History copies and searches.
  it("a two-target session keeps each language's release words on its own line", () => {
    const first = { fr: "Bonjour le", de: "Hallo die" };
    const out = appendTranslation({ text: "Bonjour le\n\nHallo die", tracks: first }, "monde\n\nWelt", { fr: "monde", de: "Welt" }, {
      targets: ["fr", "de"],
    });
    expect(out.text).toBe("Bonjour le monde\n\nHallo die Welt");
    expect(out.tracks).toEqual({ fr: "Bonjour le monde", de: "Hallo die Welt" });
  });

  it("the original kept above one target stays its own block", () => {
    const out = appendTranslation({ text: "Hello the\n\nBonjour le", tracks: { fr: "Bonjour le" } }, "world\n\nmonde", { fr: "monde" }, {
      targets: ["fr"],
      original: "Hello the world",
    });
    expect(out.text).toBe("Hello the world\n\nBonjour le monde");
  });

  it("one track joins with a space", () => {
    const out = appendTranslation({ text: "Bonjour le", tracks: { fr: "Bonjour le" } }, " monde ", { fr: "monde" }, { targets: ["fr"] });
    expect(out.text).toBe("Bonjour le monde");
    expect(out.tracks).toEqual({ fr: "Bonjour le monde" });
  });

  it("a release that opens the record's translation is its phrase as typed", () => {
    const out = appendTranslation({ text: undefined, tracks: undefined }, "monde\n\nWelt", { fr: "monde", de: "Welt" }, {
      targets: ["fr", "de"],
    });
    expect(out.text).toBe("monde\n\nWelt");
  });
});

describe("routeUtteranceClip", () => {
  // streaming.ts keeps every finished utterance by ordinal; Rust's clip writer thread can deliver
  // utterance #1's clip after #2's final or a break, when #1 is no longer the last utterance.
  const session = () => {
    const byOrdinal = new Map<number, UtteranceEntry>();
    const attached: Array<[string, UtteranceClip]> = [];
    const attach = (id: string, clip: UtteranceClip) => void attached.push([id, clip]);
    return { byOrdinal, attached, attach };
  };
  const clip1 = { path: "/rec/u1.wav", durationMs: 1800 };

  it("a clip that lands after the next utterance's final still reaches its own record", () => {
    const { byOrdinal, attached, attach } = session();
    byOrdinal.set(1, { ordinal: 1, id: "rec-1", openedAt: 0 });
    byOrdinal.set(2, { ordinal: 2, id: "rec-2", openedAt: 1 });
    expect(routeUtteranceClip(byOrdinal, 1, clip1, attach)).toBe(true);
    expect(attached).toEqual([["rec-1", clip1]]);
    // Done with #1; #2 still waits for its clip.
    expect([...byOrdinal.keys()]).toEqual([2]);
  });

  it("a clip that lands after a break still reaches its record (the break keeps the entries)", () => {
    const { byOrdinal, attached, attach } = session();
    byOrdinal.set(1, { ordinal: 1, id: "rec-1", openedAt: 0 });
    // stream://boundary nulls lastUtterance only.
    expect(routeUtteranceClip(byOrdinal, 1, clip1, attach)).toBe(true);
    expect(attached).toEqual([["rec-1", clip1]]);
  });

  it("a clip that beats its record waits on the entry for the final that writes it", () => {
    const { byOrdinal, attached, attach } = session();
    const utt: UtteranceEntry = { ordinal: 1, id: null, openedAt: 0 };
    byOrdinal.set(1, utt);
    expect(routeUtteranceClip(byOrdinal, 1, clip1, attach)).toBe(true);
    expect(attached).toEqual([]);
    expect(utt.clip).toEqual(clip1);
  });

  it("a clip for an ordinal this session never finished finds nothing", () => {
    const { byOrdinal, attached, attach } = session();
    byOrdinal.set(2, { ordinal: 2, id: "rec-2", openedAt: 0 });
    expect(routeUtteranceClip(byOrdinal, 7, clip1, attach)).toBe(false);
    expect(attached).toEqual([]);
  });
});
