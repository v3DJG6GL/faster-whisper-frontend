// Drift guard for the per-session settle picker and the session route.
//
// `askTargetsAtSettle` is armed by dictation.ts for ONE push-to-talk session and consumed
// by streaming.ts at that session's one-shot translate. Nothing else may leave it armed:
// a stale closure pops the PREVIOUS profile's picker after the next session's speech and
// rewrites that session's targets. Likewise `sessionTargets` is the chip's/tray's route
// and must die with the session, or the standby dock previews a finished run's route.
//
// Same `?raw` + brace-slice idiom as cancelAudit.test.ts: the seams are module-private.
import { describe, expect, it } from "vitest";
import streamingSrc from "./streaming.ts?raw";
import dictationSrc from "./dictation.ts?raw";

function mask(src: string): string {
  const out = src.split("");
  const blank = (i: number) => {
    if (src[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      if (i < src.length) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      blank(i++);
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") blank(i++);
        if (i < src.length) blank(i++);
      }
      if (i < src.length) blank(i++);
      continue;
    }
    i++;
  }
  return out.join("");
}

function bodyAfter(src: string, anchor: string): string {
  const masked = mask(src);
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = masked.indexOf("{", at + anchor.length);
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after: ${anchor}`);
}

describe("the settle picker is armed for exactly one session", () => {
  it("every session end disarms it", () => {
    expect(mask(bodyAfter(streamingSrc, "function settleIdle()"))).toContain("askTargetsAtSettle = null");
    expect(mask(bodyAfter(streamingSrc, "async function cancelLive("))).toContain("askTargetsAtSettle = null");
  });

  it("dictate() disarms before the hands-free branch can return early", () => {
    const body = mask(bodyAfter(dictationSrc, "export function dictate("));
    const disarm = body.indexOf("setSettleTargetPicker(null)");
    const handsFree = body.indexOf("profile.activation !==");
    expect(disarm).toBeGreaterThanOrEqual(0);
    expect(handsFree).toBeGreaterThan(disarm);
  });
});

describe("the session route dies with the session", () => {
  it("settleIdle clears sessionTargets like cancelLive does", () => {
    expect(mask(bodyAfter(streamingSrc, "function settleIdle()"))).toContain("sessionTargets: null");
    expect(mask(bodyAfter(streamingSrc, "async function cancelLive("))).toContain("sessionTargets: null");
  });

  it("a pick can create a translation the Profile did not configure", () => {
    expect(mask(bodyAfter(streamingSrc, "function applySessionTargets("))).toContain("sessionTranslationBase");
  });

  it("the picker promise settles on a transport failure", () => {
    expect(mask(bodyAfter(dictationSrc, "function askTranslationTargets("))).toContain(".catch(");
  });
});
