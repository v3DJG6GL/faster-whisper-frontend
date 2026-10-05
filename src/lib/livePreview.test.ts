import { describe, expect, it } from "vitest";
import {
  keepInnerBelowOuter,
  LIVE_FALLBACK,
  livePreview,
  pauseKind,
  previewRule,
  secText,
  separatorGlyphs,
  type PreviewToken,
} from "./livePreview";

/** The tokens as plain text, pauses as [kind], for readable assertions. */
const flat = (ts: PreviewToken[]) =>
  ts
    .map((t) =>
      t.kind === "words" ? (t.glued ? `<${t.text}>` : t.text)
      : t.kind === "period" ? "."
      : t.kind === "space" ? " "
      : t.kind === "separator" ? `{${t.text}}`
      : `[${t.pause}]`,
    )
    .join("");

describe("pauseKind", () => {
  it("sorts a pause by the four knobs", () => {
    expect(pauseKind(0.4, LIVE_FALLBACK)).toBe("go");
    expect(pauseKind(0.7, LIVE_FALLBACK)).toBe("ref");
    expect(pauseKind(1.2, LIVE_FALLBACK)).toBe("end");
    expect(pauseKind(5, LIVE_FALLBACK)).toBe("par");
  });
  it("never breaks a paragraph with the hard break off", () => {
    expect(pauseKind(60, { ...LIVE_FALLBACK, hardMs: 0 })).toBe("end");
  });
});

describe("livePreview", () => {
  it("renders the sample with the server's defaults", () => {
    expect(flat(livePreview({ ...LIVE_FALLBACK, separator: "\n" }))).toBe(
      "So the history[go] is only saved[ref] for a whole session.[end] When I use it in live mode.[par]{\n}I don't think that's a good practice[go] the backend logs each part on its own.",
    );
  });
  it("glues the next sentence on when the separator is nothing", () => {
    const ts = livePreview(LIVE_FALLBACK);
    expect(flat(ts)).toContain(".[par]<I don't think that's a good practice>");
  });
  it("a longer outer silence ends fewer sentences", () => {
    const ts = livePreview({ ...LIVE_FALLBACK, outerMs: 2500 });
    expect(ts.filter((t) => t.kind === "period")).toHaveLength(2); // the hard break + the end
  });
});

describe("previewRule / secText / separatorGlyphs", () => {
  it("writes the legend in seconds", () => {
    expect(previewRule(LIVE_FALLBACK)).toEqual({
      go: "under 0.7 s nothing",
      ref: "from 0.7 s preview refreshes",
      end: "from 1.2 s period",
      par: "from 5 s new paragraph",
    });
    expect(previewRule({ ...LIVE_FALLBACK, hardMs: 0 }).par).toBe("no paragraph breaks");
    expect(secText(0.25)).toBe("0.3 s");
  });
  it("shows a line break and a tab as glyphs", () => {
    expect(separatorGlyphs("\n\t¶")).toBe("↵⇥¶");
  });
});

describe("keepInnerBelowOuter", () => {
  it("leaves a valid pair alone", () => {
    expect(keepInnerBelowOuter("inner", 700, 1200)).toEqual({ innerMs: 700, outerMs: 1200 });
  });
  it("pushes the outer up when the inner reaches it", () => {
    expect(keepInnerBelowOuter("inner", 1200, 1200)).toEqual({ innerMs: 1200, outerMs: 1300 });
  });
  it("pulls the inner down when the outer reaches it, never under 200 ms", () => {
    expect(keepInnerBelowOuter("outer", 700, 600)).toEqual({ innerMs: 500, outerMs: 600 });
    expect(keepInnerBelowOuter("outer", 700, 250)).toEqual({ innerMs: 200, outerMs: 250 });
  });
});
