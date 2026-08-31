// Drift guard for the "tell the SERVER to stop" rule.
//
// Both classes of long-running server work here — a dictation translate and a
// batch transcription — outlive our end of the request: dropping the HTTP call
// leaves the GPU finishing a result nobody will read, for up to an hour
// (Rust's TEXT_TRANSLATE_TIMEOUT). So every teardown that abandons the work
// must cancel it, and the cost of forgetting is invisible on this side of the
// wire — which is exactly the kind of omission a test has to catch.
//
// It reads the SOURCE (the `?raw` idiom settingsLabels.test.ts established —
// the only cross-file regression mechanism here that needs no Tauri), slices
// each function body by brace depth, and asserts the call appears in it.
import { describe, expect, it } from "vitest";
import streamingSrc from "./streaming.ts?raw";
import transcribeRunSrc from "./transcribeRun.ts?raw";

/** Blank out comments, strings and template literals — same length, so indexes
 *  into the original stay valid — so the brace scan can't be thrown off by a
 *  brace inside prose or a string. */
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

/** The body of the block that opens at the first `{` at/after `anchor`. */
function bodyAfter(src: string, anchor: string): string {
  const masked = mask(src);
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = masked.indexOf("{", at + anchor.length);
  expect(open, `no block after: ${anchor}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after: ${anchor}`);
}

/** Every top-level `function name(...) {...}` in a module, by name. */
function topLevelFunctions(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^(?:export )?(?:async )?function (\w+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out[m[1]] = bodyAfter(src, m[0]);
  return out;
}

describe("dictation teardowns cancel the in-flight translate", () => {
  // A translate started for a phrase that will never be injected keeps the
  // server generating tokens; each of these paths abandons that phrase.
  const cases: Array<[anchor: string, why: string]> = [
    ["function cancelLive(", "the escape hatch — every ✕ / stop / resume path routes through it"],
    ["function stopLive(", "a rejected stop leaves no `closed` behind to clean up"],
    ["function teardownAfterFatalInject(", "the phrase that was being translated can no longer land"],
    ['"stream://error"', "the session is over; nothing will consume the translation"],
  ];
  for (const [anchor, why] of cases) {
    it(`${anchor} cancels — ${why}`, () => {
      expect(
        bodyAfter(streamingSrc, anchor).includes("cancelDictationTranslate("),
        `${anchor} in streaming.ts abandons a dictation translate without stopping the server — ` +
          "add cancelDictationTranslate() or update cancelAudit.test.ts",
      ).toBe(true);
    });
  }

  it("the SUCCESS settle deliberately does not cancel", () => {
    // settleIdle runs after the inject queue drained, so every translate has
    // already resolved — cancelling there would abort a finished (or a NEXT
    // session's) request. Pinned so the rule above isn't applied blindly.
    // Masked, so the comment that EXPLAINS the omission doesn't read as a call.
    expect(mask(topLevelFunctions(streamingSrc).settleIdle)).not.toContain(
      "cancelDictationTranslate(",
    );
  });
});

describe("every transcribe epoch bump abandons the server-side run", () => {
  // The epoch is how this module drops its end of an in-flight request; the
  // server's pipeline keeps running unless it is told otherwise. So the two
  // must always travel together.
  const fns = topLevelFunctions(transcribeRunSrc);
  const bumpers = Object.entries(fns).filter(([, body]) => body.includes("s.epoch + 1"));

  it("finds the epoch-bumping functions", () => {
    // If this list shrinks, the scan broke — not the code.
    expect(bumpers.map(([name]) => name).sort()).toEqual([
      "cancelRun",
      "closeRecord",
      "openHistoryRecord",
      "resetForInputChange",
      "startRun",
    ]);
  });

  for (const [name, body] of bumpers) {
    it(`${name} calls abandonActiveRun()`, () => {
      expect(
        body.includes("abandonActiveRun("),
        `${name} in transcribeRun.ts bumps the epoch — abandoning our end of the request — but ` +
          "never tells the server to stop; add abandonActiveRun() or update cancelAudit.test.ts",
      ).toBe(true);
    });
  }
});
