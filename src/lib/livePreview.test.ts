import { describe, expect, it } from "vitest";
import {
  keepInnerBelowOuter,
  LIVE_FALLBACK,
  livePreview,
  pauseKind,
  previewRule,
  secText,
  separatorGlyphs,
  serverTimings,
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

describe("serverTimings", () => {
  it("moves a hard break at or under the outer pause to outer + 1 s, as the server does", () => {
    const t = serverTimings({ ...LIVE_FALLBACK, innerMs: 700, outerMs: 1200, hardMs: 1000 });
    expect(t.hardMs).toBe(2200);
    expect(pauseKind(1.6, t)).toBe("end");
    expect(previewRule(t).par).toBe("from 2.2 s new paragraph");
  });
  it("keeps a hard break of 0 (never) and a valid pair as they are", () => {
    expect(serverTimings({ ...LIVE_FALLBACK, hardMs: 0 })).toEqual({ ...LIVE_FALLBACK, hardMs: 0 });
    expect(serverTimings(LIVE_FALLBACK)).toEqual(LIVE_FALLBACK);
  });
  it("pulls an inner pause at or over the outer one to outer − 50 ms", () => {
    expect(serverTimings({ ...LIVE_FALLBACK, innerMs: 1200, outerMs: 1200 }).innerMs).toBe(1150);
  });
  describe("with who supplies each pause (routes.py _client_stream_values)", () => {
    const none = { inner: false, outer: false, hard: false };
    it("drops a client outer that conflicts with a LOCKED inner: the server's outer runs, the inner stays", () => {
      const t = serverTimings(
        { ...LIVE_FALLBACK, innerMs: 1500, outerMs: 1200 },
        { client: { ...none, outer: true }, innerLocked: true, hardLocked: false, serverOuterMs: 2000 },
      );
      expect(t).toMatchObject({ innerMs: 1500, outerMs: 2000, hardMs: 5000 });
      expect(previewRule(t).end).toBe("from 2 s period");
    });
    it("drops a client outer that conflicts with a LOCKED hard break, leaving the hard break", () => {
      const t = serverTimings(
        { ...LIVE_FALLBACK, outerMs: 1200, hardMs: 1000 },
        { client: { ...none, outer: true }, innerLocked: false, hardLocked: true, serverOuterMs: 2000 },
      );
      expect(t).toMatchObject({ innerMs: 700, outerMs: 2000, hardMs: 1000 });
    });
    it("clamps a client-sent pair as before when nothing is locked", () => {
      const facts = { client: { inner: true, outer: true, hard: true }, innerLocked: false, hardLocked: false, serverOuterMs: 2000 };
      expect(serverTimings({ ...LIVE_FALLBACK, innerMs: 1200, outerMs: 1200, hardMs: 1000 }, facts)).toEqual({
        ...LIVE_FALLBACK,
        innerMs: 1150,
        outerMs: 1200,
        hardMs: 2200,
      });
    });
    it("leaves the server's own values alone when no client value takes part", () => {
      const t = { ...LIVE_FALLBACK, innerMs: 1200, outerMs: 1200, hardMs: 1000 };
      expect(serverTimings(t, { client: none, innerLocked: false, hardLocked: false, serverOuterMs: 1200 })).toEqual(t);
    });
  });
  it("keeps the pulled-down inner pause apart from the outer one in the legend", () => {
    const rule = previewRule(serverTimings({ ...LIVE_FALLBACK, innerMs: 1200, outerMs: 1200 }));
    expect(rule.ref).toBe("from 1.15 s preview refreshes");
    expect(rule.end).toBe("from 1.2 s period");
  });
});
