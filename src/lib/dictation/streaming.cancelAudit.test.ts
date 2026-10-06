// Drift guard for the "tell the SERVER to stop" rule.
//
// Both classes of long-running server work here — a dictation translate and a
// batch transcription — outlive our end of the request: dropping the HTTP call
// leaves the GPU finishing a result nobody will read, for up to an hour
// (Rust's TEXT_TRANSLATE_TIMEOUT). So every teardown that abandons the work
// must cancel it, and the cost of forgetting is invisible on this side of the
// wire — which is exactly the kind of omission a test has to catch.
//
// It reads the SOURCE (the `?raw` idiom settingsManifest.labels.test.ts established —
// the only cross-file regression mechanism here that needs no Tauri), slices
// each function body by brace depth, and asserts the call appears in it.
import { describe, expect, it } from "vitest";
import streamingSrc from "./streaming.ts?raw";
import transcribeRunSrc from "../transcribeRun.ts?raw";

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
    // Regex literals: a `/` preceded by an operator-class character is a regex
    // opener, not division. Without this, a regex containing a quote or brace
    // (e.g. /[^"]/  or /x{2,}/) opens a bogus mask that blanks real source or
    // contributes unbalanced braces to the depth count in bodyAfter().
    if (c === "/" && i > 0 && /[=(!,:;?[{&|~^%*/+\-<>]/.test(src[i - 1])) {
      blank(i++); // opening /
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") blank(i++); // escape in regex
        if (src[i] === "[") { // character class — scan to ]
          blank(i++);
          while (i < src.length && src[i] !== "]") {
            if (src[i] === "\\") blank(i++);
            if (i < src.length) blank(i++);
          }
        }
        if (i < src.length) blank(i++);
      }
      if (i < src.length) blank(i++); // closing /
      while (i < src.length && /[gimsuy]/.test(src[i])) blank(i++); // flags
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
      const body = mask(bodyAfter(streamingSrc, anchor));
      expect(
        body.includes("abandonSessionWork(") || body.includes("cancelDictationTranslate("),
        `${anchor} in streaming.ts abandons a dictation translate without stopping the server — ` +
          "add abandonSessionWork() or update streaming.cancelAudit.test.ts",
      ).toBe(true);
    });
  }

  it("abandonSessionWork stops the translate and the pending phrase-end work", () => {
    // The shared teardown is only as good as its body: the four sites above rely on it.
    const body = mask(topLevelFunctions(streamingSrc).abandonSessionWork);
    for (const step of ["cancelDictationTranslate(", "clearPhraseEnd(", "clearStuckWatchdog(", "stopTargetPoll(", "clearWarmTimer(", "releaseWarmLease("]) {
      expect(body, `abandonSessionWork must call ${step}`).toContain(step);
    }
  });

  it("only the user's cancel aborts an in-flight injection", () => {
    // cancelLive passes the user-initiated flag so Rust aborts a transcript being typed even
    // after the session is gone (stop-timing); the closed handler's idempotent release must
    // NOT, or the end-of-session insert queued moments later would be aborted.
    const cancelLive = mask(topLevelFunctions(streamingSrc).cancelLive);
    expect(cancelLive).toContain("cancelRecord(true)");
    expect(cancelLive).toContain("cancelStream(true)");
    const closedRelease = streamingSrc.match(/\(activeEndpoint === "batch" \? cancelRecord\(([^)]*)\) : cancelStream\(([^)]*)\)\)/);
    expect(closedRelease, "the closed-handler release moved — update streaming.cancelAudit.test.ts").not.toBeNull();
    expect(closedRelease![1]).toBe("");
    expect(closedRelease![2]).toBe("");
  });

  it("the SUCCESS settle deliberately does not cancel", () => {
    // settleIdle runs after the inject queue drained, so every translate has
    // already resolved — cancelling there would abort a finished (or a NEXT
    // session's) request. Pinned so the rule above isn't applied blindly.
    // Masked, so the comment that EXPLAINS the omission doesn't read as a call.
    const settle = mask(topLevelFunctions(streamingSrc).settleIdle);
    expect(settle).not.toContain("cancelDictationTranslate(");
    expect(settle).not.toContain("abandonSessionWork(");
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
      "reattachRun",
      "resetForInputChange",
      "startRun",
    ]);
  });

  for (const [name, body] of bumpers) {
    it(`${name} calls abandonActiveRun()`, () => {
      expect(
        body.includes("abandonActiveRun("),
        `${name} in transcribeRun.ts bumps the epoch — abandoning our end of the request — but ` +
          "never tells the server to stop; add abandonActiveRun() or update streaming.cancelAudit.test.ts",
      ).toBe(true);
    });
  }
});

describe("live typed baseline: the hard-break carry and clipboard delivery", () => {
  // The carry (text a hard break threw away before it was typed) and the clipboard-delivered
  // advance are both bookkeeping on `injectedText` spread across three handlers and two
  // teardowns. None of it is reachable without Tauri, so pin the shape here: a carry that
  // outlives its session types session A's leftovers into session B's window, and an ungated
  // one types a stop-timing session's text twice.
  const fns = topLevelFunctions(streamingSrc);
  const finalBody = bodyAfter(streamingSrc, '"stream://final"');
  const boundaryBody = bodyAfter(streamingSrc, '"stream://boundary"');
  const clears = (body: string) => /\bcarryText =\s+;/.test(mask(body)) && /\bcarrySep =\s+;/.test(mask(body));

  it("cancelLive and startLiveInner clear the carry", () => {
    expect(clears(fns.cancelLive), "cancelLive must drop a pending carry").toBe(true);
    expect(clears(fns.startLiveInner), "startLiveInner must not inherit the last session's carry").toBe(true);
  });

  it("the boundary captures the document before clearing it", () => {
    const m = mask(boundaryBody);
    const capture = m.indexOf("const docAtBreak = committedDoc");
    const clear = m.search(/\bcommittedDoc =\s+;/);
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(capture);
  });

  it("the boundary link carries only for a live session, then clears the baseline", () => {
    const link = mask(bodyAfter(boundaryBody, "injectChain = injectChain.then(() =>"));
    const gate = link.indexOf("cfg?.live");
    const carry = link.indexOf("untypedRemainder(");
    expect(gate, "boundary link lost its live gate").toBeGreaterThanOrEqual(0);
    expect(carry).toBeGreaterThan(gate);
    expect(link).toMatch(/\binjectedText =\s+;/);
  });

  it("the separator task stands down while a carry is pending", () => {
    const task = bodyAfter(boundaryBody, "enqueueInject(async () =>");
    const skip = task.indexOf("if (carryText) return");
    expect(skip, "separator task must skip while a carry is pending").toBeGreaterThanOrEqual(0);
    expect(task.indexOf("holdCoerced(")).toBeGreaterThanOrEqual(0);
    expect(skip).toBeGreaterThan(task.indexOf("holdCoerced("));
    expect(skip).toBeLessThan(task.indexOf("t.autoEnter"));
  });

  it("a delivered typed insert consumes the carry", () => {
    // Trailing space, no brace: bodyAfter opens at the first `{` AFTER the anchor.
    expect(clears(bodyAfter(finalBody, "if (delivered) "))).toBe(true);
  });

  it("a delivered clipboard phrase advances the typed baseline (guarded by clipFrom)", () => {
    const block = bodyAfter(finalBody, "if (!t.isSelf && landed)");
    expect(block).toContain("commonPrefixLen(injectedText, target) >= clipFrom");
    expect(block).toContain("injectedText = target");
  });

  it("a release final (no utterance ordinal) doesn't end the open utterance", () => {
    expect(finalBody).toContain('if (typeof e.payload.utterance === "number" || pending.state === null) endUtterance();');
  });

  it("the closing final (last: true) books its words onto the last utterance, not its phantom ordinal", () => {
    // The server stamps its close() final with the NEXT ordinal, one no `open` announced; History
    // and the capture pairing must treat it as a release final.
    const body = mask(finalBody);
    expect(finalBody).toContain('const ordinal = typeof e.payload.utterance === "number" && !e.payload.last ? e.payload.utterance : null;');
    expect(body).toContain("recordUtteranceFinal(ordinal)");
    expect(body).toContain("const utterance = ordinal;");
  });
});

describe("insertion gates the re-derivations must keep", () => {
  const fns = topLevelFunctions(streamingSrc);
  const finalBody = bodyAfter(streamingSrc, '"stream://final"');

  it("applyReclassify keeps startLiveInner's insertTiming-off term on its live recompute", () => {
    // The closed handler's off-drop only runs when `live` is false, so an "off" session that a
    // hold→hands-free upgrade flipped live would type every phrase.
    // (startLiveInner's extra `!askTargetsAtSettle` term is deliberately start-only: an armed
    // push-to-talk picker's session shape never upgrades in place — see sessionShape.ts.)
    expect(fns.startLiveInner).toContain('g.insertTiming !== "off" && !askTargetsAtSettle && liveAllowed(');
    expect(fns.applyReclassify).toContain('insertCfg.timing !== "off" && liveAllowed(');
  });

  it("a delivered paste owes a restore only when its own window's rule asks for one", () => {
    // A bare `clipDirty = true` re-armed an earlier window's snapshot over a restore-off app's
    // transcript.
    const block = bodyAfter(finalBody, 'else if (t.method === "paste" && delivered)');
    expect(block).toContain("clipDirty = t.restoreClipboard");
  });

  it("each inject-chain generation counts its own depth", () => {
    // A shared number reset to 0 lets the abandoned chain's finallys drive the new session's
    // depth (the translate ceiling's slack) negative.
    const enqueue = mask(fns.enqueueInject);
    expect(enqueue).toContain("const d = injectDepth;");
    expect(enqueue).toContain("d.n--");
    expect(enqueue).not.toMatch(/\binjectDepth(\.n)?(\+\+|--)/);
    for (const name of ["cancelLive", "startLiveInner"]) {
      expect(mask(fns[name]), `${name} must start a new depth generation`).toMatch(/\binjectDepth = \{ n: 0 \}/);
    }
  });
});

describe("work that must wait for the queue or the cancel", () => {
  // Ordering rules no unit test can reach without Tauri: each one used to run synchronously
  // against an IPC or a queued task it raced, so pin the order in the source.
  const fns = topLevelFunctions(streamingSrc);

  it("the stuck-finalize recovery copy waits for cancelLive's cancel before copying", () => {
    // cancelStream(true) and the synchronous idle land before the copy (and before the superseded
    // check). endInjection is only void-chained by cancelLive; it is a no-op in stop mode, the only
    // mode with a pending transcript here.
    const body = mask(fns.armStuckWatchdog);
    expect(body).not.toMatch(/void cancelLive\(\)/);
    const wait = body.indexOf("await cancelled");
    expect(wait, "recovery must await the cancel").toBeGreaterThanOrEqual(0);
    expect(body.indexOf("recoverUnguarded(")).toBeGreaterThan(wait);
  });

  it("the stream-error handler flashes the error before awaiting the recovery copy", () => {
    // A dead socket emits error then `closed` back-to-back; a flash deferred behind the copy lets
    // that `closed` see a live status, cancel + settleIdle the session, and then the late flash
    // can stamp a newly started session "error".
    const body = mask(bodyAfter(streamingSrc, 'reg<string>("stream://error"'));
    const flash = body.indexOf("flashError(");
    expect(flash, "stream-error handler must flash").toBeGreaterThanOrEqual(0);
    const copy = body.indexOf("recoverUnguarded(");
    expect(copy, "stream-error recovery must use recoverUnguarded").toBeGreaterThanOrEqual(0);
    expect(flash).toBeLessThan(copy);
    // The post-await upgrade must not re-flash (that would stamp a superseding session).
    expect(body.indexOf("flashError(", copy)).toBe(-1);
  });

  it("a rejected stop flashes the error before awaiting the recovery copy", () => {
    // The chip sits on "transcribing" until the flash; a flash deferred behind the copy lets a
    // cancel + fresh press land in between, and the late flash then stamps the new session "error".
    const body = mask(fns.stopLive);
    const flash = body.indexOf("flashError(");
    expect(flash, "stop-reject path must flash").toBeGreaterThanOrEqual(0);
    const copy = body.indexOf("recoverUnguarded(");
    expect(copy, "stop-reject recovery must use recoverUnguarded").toBeGreaterThanOrEqual(0);
    expect(flash).toBeLessThan(copy);
    expect(body.indexOf("flashError(", copy)).toBe(-1);
  });

  it("the stop-mode sink-skip recovery copies without the own-window guard, then re-checks the session", () => {
    // The skip's main cause is our own window taking focus; inject_text's clipboard method
    // writes nothing then, so the whole transcript would be lost behind a false "not on the clipboard".
    const block = mask(bodyAfter(streamingSrc, "} else if (!t.isSelf && !landed)"));
    expect(block).not.toContain("recoverToClipboard(");
    const copy = block.indexOf("recoverUnguarded(");
    expect(copy, "sink-skip recovery must use recoverUnguarded").toBeGreaterThanOrEqual(0);
    expect(block.indexOf("insertCfg !== cfg", copy)).toBeGreaterThan(copy);
  });

  it("the stuck-finalize recovery stands down for a session started while it awaited", () => {
    // cancelLive idles the chip synchronously, so a new session can start before the recovery's
    // awaits finish; an unguarded flashError then stamps THAT session "error" (frames dropped,
    // lease released, capture and system mute left up).
    const body = mask(fns.armStuckWatchdog);
    const recovery = body.slice(body.indexOf("await cancelled"));
    expect(recovery.length).toBeLessThan(body.length);
    const guard = recovery.indexOf("insertCfg !== null");
    expect(guard, "recovery must check for a superseding session").toBeGreaterThanOrEqual(0);
    expect(recovery.indexOf("flashError(")).toBeGreaterThan(guard);
    // …and for an open translation-target picker (startLive only runs after the pick).
    const picker = recovery.indexOf("routePending ==="); // string literals are masked
    expect(picker, "recovery must treat an open target picker as superseding").toBeGreaterThanOrEqual(0);
    expect(recovery.indexOf("flashError(")).toBeGreaterThan(picker);
  });

  it("the live closed tail chains its final clipboard restore past the flood cap", () => {
    // enqueueInject drops work at MAX_INJECT_DEPTH; the session's last restore must never be dropped.
    const closed = mask(bodyAfter(streamingSrc, 'e.payload === "closed"'));
    expect(closed).not.toContain("enqueueInject(finalClip)");
    const at = closed.indexOf("const tailCfg = cfg;");
    expect(at, "the final-clip link moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const link = closed.slice(at, closed.indexOf("settleToIdleAfterInjection(", at));
    expect(link, "finalClip must be chained directly").toMatch(/injectChain = injectChain\s*\.then\([^;]*finalClip\(\)/);
  });

  it("the phrase-end timer decides restore and closes the clipboard window in the queue", () => {
    // Both depend on clipDirty / the window booking, which the queued phrase task sets only after
    // an awaited translate + inject — routinely longer than the 1.2 s quiet gap.
    const timer = mask(fns.bumpPhraseEnd);
    const link = mask(bodyAfter(fns.bumpPhraseEnd, "injectChain = injectChain.then(async () =>"));
    for (const step of ["clipDirty && beganInjection", "restoreClipboardSnapshot(", "clipBooked = null", "flushClipByLang("]) {
      expect(link, `${step} must run inside the queued link`).toContain(step);
    }
    // Only the link may touch them; the baseline stays synchronous (read at enqueue).
    expect(timer.split("clipBooked = null").length).toBe(2);
    expect(timer.split("flushClipByLang(").length).toBe(2);
    expect(timer).not.toContain("enqueueRestoreSnapshot(");
    const base = timer.indexOf("clipBaseline = committedDoc");
    expect(base, "the clipboard baseline must still advance synchronously").toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(timer.indexOf("injectChain = injectChain.then("));
  });

  it("a hard break closes the clipboard window in its chained link, not synchronously", () => {
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const link = mask(bodyAfter(boundary, "injectChain = injectChain.then(() =>"));
    expect(link).toContain("clipBooked = null");
    expect(link).toContain("flushClipByLang(");
    expect(mask(boundary).split("clipBooked = null").length, "only the link may close the window").toBe(2);
  });

  it("a hard break decides its restore backstop in the queue, not synchronously", () => {
    // Same race as the phrase-end timer: a phrase task still awaiting its translate sets
    // clipDirty after the break, so a synchronous read misses the debt and a synchronous
    // clear wipes it.
    const boundary = mask(bodyAfter(streamingSrc, '"stream://boundary"'));
    const link = mask(bodyAfter(bodyAfter(streamingSrc, '"stream://boundary"'), "injectChain = injectChain.then(async () =>"));
    expect(link).toContain("restoreClipboardSnapshot(");
    for (const step of ["clipDirty && beganInjection", "clipDirty = false"]) {
      expect(link, `${step} must run inside the queued link`).toContain(step);
      const inLink = link.split(step).length;
      expect(boundary.split(step).length, `${step} must not run synchronously in the boundary`).toBe(inLink);
    }
  });
});
