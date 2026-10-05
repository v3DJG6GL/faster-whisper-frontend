// The live-typing baseline's arithmetic: the diff, the hard-break carry and the divergence
// report. Pure, so testable without Tauri — the handlers that use it in streaming.ts are pinned
// by source pattern in streaming.cancelAudit.test.ts instead.

import { describe, expect, it } from "vitest";
import { baselineDivergence, charClass, commonPrefixLen, joinCarry, untypedRemainder, withCarry } from "./typedBaseline";

describe("commonPrefixLen", () => {
  it("measures the shared prefix", () => {
    expect(commonPrefixLen("", "")).toBe(0);
    expect(commonPrefixLen("abc", "")).toBe(0);
    expect(commonPrefixLen("abc", "abd")).toBe(2);
    expect(commonPrefixLen("abc", "abcdef")).toBe(3);
    expect(commonPrefixLen("abcdef", "abc")).toBe(3);
  });
});

describe("untypedRemainder", () => {
  it("is what lies beyond the typed text", () => {
    expect(untypedRemainder("Hallo Welt.", "Hallo Welt. Zweiter Satz.")).toBe(" Zweiter Satz.");
  });

  it("is the whole document when nothing was typed (own-window skip)", () => {
    expect(untypedRemainder("", "Alles ungetippt.")).toBe("Alles ungetippt.");
  });

  it("is empty when everything was typed", () => {
    expect(untypedRemainder("Fertig.", "Fertig.")).toBe("");
  });

  it("re-sends from a divergence, like the live diff (duplication over loss)", () => {
    expect(untypedRemainder("Er sagte „ja", "Er sagte „ja“ und ging.")).toBe("“ und ging.");
    expect(untypedRemainder("A, B", "A. B und C")).toBe(". B und C");
  });
});

describe("joinCarry", () => {
  it("joins with the boundary separator, trimming both seams", () => {
    expect(joinCarry("Erster Teil. ", "\n", "  Zweiter Teil")).toBe("Erster Teil.\nZweiter Teil");
  });

  it("uses a space when the break has no separator", () => {
    expect(joinCarry("eins", "", "zwei")).toBe("eins zwei");
  });

  it("returns the other side when one is empty", () => {
    expect(joinCarry("", " — ", "nur neu")).toBe("nur neu");
    expect(joinCarry("nur alt  ", " — ", "")).toBe("nur alt");
    expect(joinCarry("", "", "")).toBe("");
  });

  it("stacks over several breaks in order", () => {
    const one = joinCarry("A", "\n", "B");
    expect(joinCarry(one, " ", "C")).toBe("A\nB C");
  });
});

describe("withCarry", () => {
  it("passes the new text through when nothing is carried", () => {
    expect(withCarry("", "\n", " neu")).toBe(" neu");
  });

  it("joins a carry to the next text like joinCarry", () => {
    expect(withCarry(" B", "\n", "C")).toBe(" B\nC");
  });

  it("keeps the separator when the carry goes out alone", () => {
    // Otherwise the next document's first phrase would glue onto the carry's last word.
    expect(withCarry("rest ", "\n", "")).toBe("rest\n");
    expect(withCarry("rest", "", "  ")).toBe("rest ");
  });
});

describe("charClass", () => {
  it("classifies without revealing the character", () => {
    expect(charClass(undefined)).toBe("end");
    expect(charClass("")).toBe("end");
    expect(charClass("\n")).toBe("newline");
    expect(charClass(" ")).toBe("space");
    expect(charClass("ß")).toBe("letter");
    expect(charClass("7")).toBe("digit");
    expect(charClass("„")).toBe("quote");
    expect(charClass('"')).toBe("quote");
    expect(charClass(",")).toBe("punct");
    expect(charClass("¿")).toBe("punct");
    expect(charClass(">")).toBe("punct");
  });
});

describe("baselineDivergence", () => {
  it("is null while the document extends what was typed", () => {
    expect(baselineDivergence("", "anything")).toBeNull();
    expect(baselineDivergence("Hallo", "Hallo")).toBeNull();
    expect(baselineDivergence("Hallo", "Hallo Welt")).toBeNull();
  });

  it("reports a rewrite by position and character class", () => {
    expect(baselineDivergence("Wert 12, 5", "Wert 12,5 mg")).toEqual({
      at: 8,
      typedLen: 10,
      docLen: 12,
      typedCh: "space",
      docCh: "digit",
    });
  });

  it("reports a shrunk document at its end", () => {
    expect(baselineDivergence("Satz eins.", "Satz eins")).toEqual({
      at: 9,
      typedLen: 10,
      docLen: 9,
      typedCh: "punct",
      docCh: "end",
    });
  });

  it("never carries text in its answer", () => {
    const d = baselineDivergence("geheim A", "geheim B")!;
    expect(JSON.stringify(d)).not.toContain("geheim");
  });
});
