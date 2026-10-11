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
import dictationSrc from "./dictation.ts?raw";
import { incompleteSurface, translationOutcome } from "./streaming";

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
    // A recovery cancel (keepRecording) keeps a detached batch's .wav/.txt, as it does a stream's.
    expect(cancelLive).toContain("cancelRecord(true, !opts?.keepRecording)");
    expect(cancelLive).toContain("cancelStream(true, !opts?.keepRecording)");
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

  it("the per-phrase Enter stands down while a carry is pending", () => {
    const task = mask(fns.enqueueAutoEnter);
    const skip = task.indexOf("if (carryText) return");
    expect(skip, "auto-Enter task must skip while a carry is pending").toBeGreaterThanOrEqual(0);
    expect(skip).toBeGreaterThan(task.indexOf("holdCoerced("));
    expect(skip).toBeLessThan(task.indexOf("t.autoEnter"));
  });

  it("a chord-family upgrade/restart leaves a finalizing session alone", () => {
    // After stopLive the mic is closed but insertCfg is intact: flipping `live` would drop the
    // stop-mode insert, and cancelling would discard the draining transcript unsaved.
    expect(mask(fns.reclassifyLive)).toContain("!capturing");
    const restart = mask(fns.restartLiveAs);
    const gate = restart.indexOf("!capturing");
    expect(gate, "restartLiveAs must not cancel a draining session").toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(restart.indexOf("cancelLive("));
    // dictate()'s reclassify arm for that window also drops the root's queued re-press: the
    // engine has handed the hold off, so a hold session started from it on settle never stops.
    const src = mask(dictationSrc);
    const arm = src.indexOf("else if (!isCapturing() && !isStarting())");
    expect(arm, "finalizing no-op arm in dictate()").toBeGreaterThanOrEqual(0);
    const next = src.indexOf("} else if (handsFree", arm);
    expect(next, "handsFree arm after the finalizing arm").toBeGreaterThan(arm);
    expect(src.slice(arm, next)).toContain("voidPendingHoldStart()");
  });

  it("an upgrade queued after startLiveInner's own drain is applied when the start settles", () => {
    // During the start invoke's await status is already "listening" but startingSession is still
    // true, so reclassifyLive queues — only startLive's finally runs after that, so it must drain.
    const body = mask(fns.startLive);
    const reset = body.indexOf("startingSession = false");
    expect(reset, "startLive's finally resets startingSession").toBeGreaterThanOrEqual(0);
    const tail = body.slice(reset);
    expect(tail).toContain("pendingReclassify = null");
    // Routed through reclassifyLive so the post-start gate has one copy; the reset must come
    // first, or the call would hit the queue arm and re-strand the upgrade.
    const call = tail.indexOf("reclassifyLive(upgraded)");
    expect(call, "startLive's finally must hand the slot to reclassifyLive").toBeGreaterThan(0);
  });

  it("a delivered typed insert consumes the carry", () => {
    // Trailing space, no brace: bodyAfter opens at the first `{` AFTER the anchor.
    expect(clears(bodyAfter(finalBody, "if (delivered) "))).toBe(true);
  });

  it("a diverted live phrase disarms the per-phrase and tail Enter", () => {
    const diverted = mask(bodyAfter(finalBody, "if (delivered && diverted) "));
    // NOT cleared here: a later phrase's final arms `phraseDirty` synchronously while this queued
    // task awaits, and an in-queue clear would wipe that typed phrase's own Enter.
    expect(/\bphraseDirty = false;/.test(diverted)).toBe(false);
    // The Enter producers arm off `phraseDirty` synchronously — before this queued task runs —
    // so the queued Enter tasks themselves must see the divert, or Return submits the partial
    // message / lands in the window that took focus.
    expect(diverted).toContain("lastPhraseDiverted = true;");
    const enter = mask(fns.enqueueAutoEnter);
    const skip = enter.indexOf("if (lastPhraseDiverted) return;");
    expect(skip, "auto-Enter task must stand down after a diverted phrase").toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(enter.indexOf("injectText("));
    // The boundary task stands down before BOTH its Enter and its separator (a newline
    // separator presses a real Return too).
    const boundary = mask(bodyAfter(boundaryBody, "enqueueInject(async () =>"));
    const bskip = boundary.indexOf("if (lastPhraseDiverted) return;");
    expect(bskip, "boundary task must stand down after a diverted phrase").toBeGreaterThanOrEqual(0);
    expect(bskip).toBeLessThan(boundary.indexOf("if (t.autoEnter)"));
    expect(bskip).toBeLessThan(boundary.indexOf("if (!sep) return;"));
    // A later phrase that really typed re-arms it; a session reset starts clean.
    expect(mask(bodyAfter(finalBody, "if (delivered) "))).toContain("lastPhraseDiverted = false;");
    expect(mask(fns.clearPhraseEnd)).toContain("lastPhraseDiverted = false;");
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
    expect(body).not.toMatch(/void cancelLive\(/);
    // A recovery cancel: the draining stream keeps its recording (the transcript is lost).
    expect(body).toContain("cancelLive({ keepRecording: true })");
    const wait = body.indexOf("await cancelled");
    expect(wait, "recovery must await the cancel").toBeGreaterThanOrEqual(0);
    expect(body.indexOf("recoverUnguarded(")).toBeGreaterThan(wait);
  });

  it("the stuck-finalize recovery books its usage outcome only once the copy answers", () => {
    // cancelLive's synchronous "nothing landed" report used to win the once-guard before the copy
    // ran, so Statistics showed Nothing for text the chip said was on the clipboard. The watchdog
    // claims the outcome before the cancel and settles it with the copy's answer.
    const body = mask(fns.armStuckWatchdog);
    const claim = body.indexOf("const settleOutcome = pending ? deferSessionOutcome() : null;");
    expect(claim, "the watchdog claims the outcome").toBeGreaterThanOrEqual(0);
    expect(claim, "…before cancelLive reports it").toBeLessThan(body.indexOf("cancelLive("));
    // mask() blanks the delivery literals; the abandoned flag is the failed copy.
    const settle = body.search(/\bsettleOutcome\?\.\(onClipboard \?\s+:\s+, !onClipboard\)/);
    expect(settle, "the copy's answer settles the outcome").toBeGreaterThan(body.indexOf("recoverUnguarded("));
    // Both branches: before the superseded check returns early.
    expect(settle).toBeLessThan(body.indexOf("if (superseded)"));
    expect(mask(streamingSrc)).not.toMatch(/\brecovered:/);
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

  it("the drain-timeout warning stays non-fatal so the closed tail still inserts", () => {
    // stream://incomplete (Rust drain idle window hit) must only warn: routing it through the
    // fatal teardown skipped the stop-mode insert and dropped the pending phrase-end Enter.
    const body = mask(bodyAfter(streamingSrc, 'reg<string>("stream://incomplete"'));
    expect(body).toContain("setLogsDoorway(");
    for (const fatal of ["flashError(", "abandonSessionWork(", "retireSessionEpoch(", "insertCfg = null", "clearPhraseEnd("]) {
      expect(body, `stream://incomplete must not call ${fatal}`).not.toContain(fatal);
    }
  });

  it("the drain-timeout warning reaches the chip, not only the main window's doorway", () => {
    // The doorway lives in the main window, which sits in the tray while dictating into
    // another app: the notice must mark the session, and the settle must turn the mark into a
    // chip note or (nothing survived) a chip error — after the bookkeeping, before a re-press.
    const handler = mask(bodyAfter(streamingSrc, 'reg<string>("stream://incomplete"'));
    expect(handler).toContain("sessionIncomplete = e.payload");
    const settle = mask(bodyAfter(streamingSrc, "function settleIdle("));
    const read = settle.indexOf("incompleteSurface(");
    const history = settle.indexOf("captureDictationHistory(");
    const flash = settle.indexOf("flashError(");
    const holdStart = settle.indexOf("consumePendingHoldStart(");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(flash, "settleIdle must flash when nothing survived").toBeGreaterThan(history);
    expect(holdStart).toBeGreaterThan(flash);
    // The note branch itself, not merely the word: the comment above it also says "incomplete".
    expect(bodyAfter(streamingSrc, "function settleIdle(")).toMatch(/incomplete === "note"\s*\?\s*"incomplete"/);
    // The flash means NOTHING survived; the Rust notice ("the last phrase may be missing")
    // would understate that on the chip.
    expect(settle).not.toContain("flashError(sessionIncomplete)");
    for (const end of ["async function startLiveInner(", "async function cancelLive("]) {
      expect(mask(bodyAfter(streamingSrc, end)), `${end} must reset the mark`).toContain("sessionIncomplete = null");
    }
  });

  it("an incomplete session errors only when nothing of it survived", () => {
    expect(incompleteSurface(false, "", "none")).toBeNull();
    expect(incompleteSurface(false, "hello", "typed")).toBeNull();
    // Nothing committed, nothing landed: the dictation is gone — say so as an error.
    expect(incompleteSurface(true, "  ", "none")).toBe("flash");
    // Committed text (stop mode, about to be / already inserted) or a landed phrase: a note.
    expect(incompleteSurface(true, "hello", "none")).toBe("note");
    expect(incompleteSurface(true, "hello", "typed")).toBe("note");
    expect(incompleteSurface(true, "", "clipboard")).toBe("note");
  });

  it("the incomplete flash never drops a queued fast re-press", () => {
    // flashError voids pendingHoldStart; settleIdle snapshots the queued press around its
    // flash and hands it to consumePendingHoldStart afterwards, which may start over "error".
    const settle = mask(bodyAfter(streamingSrc, "function settleIdle("));
    const flash = settle.indexOf("flashError(");
    const snap = settle.lastIndexOf("= pendingHoldStart", flash);
    const restore = settle.indexOf("pendingHoldStart = ", flash);
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(flash);
    expect(settle.indexOf("consumePendingHoldStart(")).toBeGreaterThan(restore);
    const consume = bodyAfter(streamingSrc, "function consumePendingHoldStart(");
    expect(consume).toMatch(/status === "error"/);
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

  it("the stop-mode failed-insert recovery books the clipboard outcome before flashing", () => {
    // settleToIdleAfterInjection runs settleIdle(true) on the "error" status, so without the
    // booking History and the outcome report record "none" for text the chip says is on the clipboard.
    const src = mask(streamingSrc); // same offsets as streamingSrc; literals are masked
    const copy = streamingSrc.indexOf('recoverToClipboard(outText, t, "failed insert")');
    expect(copy, "failed-insert recovery moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const flash = src.indexOf("flashError(", copy);
    expect(flash).toBeGreaterThan(copy);
    expect(src.slice(copy, flash)).toContain("sessionClipboard = true");
  });

  it("the live per-phrase failed-insert recovery books the phrase's utterance record before flashing", () => {
    // A per-utterance session opens each record as "none" for bookUtteranceInsert to patch, and
    // teardownAfterFatalInject never settles it: unbooked, History says "not inserted" for a phrase
    // the chip says is on the clipboard.
    const src = mask(streamingSrc); // same offsets as streamingSrc; literals are masked
    const reason = streamingSrc.indexOf('"failed live insert"');
    expect(reason, "live failed-insert recovery moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const copy = streamingSrc.lastIndexOf("recoverToClipboard(", reason);
    expect(copy).toBeGreaterThanOrEqual(0);
    const flash = src.indexOf("flashError(", reason);
    expect(flash).toBeGreaterThan(reason);
    const between = streamingSrc.slice(copy, flash);
    expect(src.slice(copy, flash)).toContain("sessionClipboard = true");
    expect(between).toContain('bookUtteranceInsert(uttRec, "clipboard"');
    // …and the skipped phrases re-sent with it: the recovery copy is that whole insert.
    expect(between).toContain('bookOwedUtterances("clipboard", { kind: "body" })');
  });

  it("a live phrase skipped in our own window is booked by the insert that later carries it", () => {
    // Its record opens as "none"; its text goes out with a later phrase's insert (un-advanced
    // baseline, clipboard window or carry), which used to book only that later record.
    for (const [anchor, book] of [
      ["if (delivered)", 'bookOwedUtterances(diverted ? "clipboard" : "typed", { kind: "body" })'],
      ["if (!t.isSelf && landed)", 'bookOwedUtterances("clipboard", { kind: "window", from: clipFrom })'],
    ] as const) {
      // The code, not the comments that quote it: anchor on the opening brace.
      const at = streamingSrc.indexOf(`${anchor} {`);
      expect(at, `${anchor} moved — update streaming.cancelAudit.test.ts`).toBeGreaterThanOrEqual(0);
      const block = bodyAfter(streamingSrc.slice(at), anchor);
      expect(block, `${anchor} must book the owed records it delivered`).toContain(book);
      const after = streamingSrc.slice(at + anchor.length + 1 + block.length).trimStart();
      expect(after.startsWith("else {"), `${anchor} needs an else that owes the skipped record`).toBe(true);
      expect(bodyAfter(after, "else")).toContain("oweUtterance(uttRec, uttFrom)");
    }
    // A hard break hands them to the carry (or drops them), and the carry's drop drops them too.
    const link = bodyAfter(bodyAfter(streamingSrc, '"stream://boundary"'), "injectChain = injectChain.then(() =>");
    expect(link).toContain('{ kind: "break", carried: !!rest.trim() }');
    expect(topLevelFunctions(streamingSrc).noteDroppedCarry).toContain('{ kind: "drop" }');
  });

  it("a final that added no text neither books nor owes the earlier record it reports", () => {
    // recordUtteranceFinal hands a re-sent/flush final its utterance's previous record with an
    // empty delta; booking it re-stamps a clipboard record "typed", owing it re-owes booked text.
    for (const name of ["bookUtteranceInsert", "oweUtterance"]) {
      // Past the signature: its parameter's object type is the first brace topLevelFunctions sees.
      const at = streamingSrc.indexOf(`function ${name}(`);
      expect(at, `${name} moved — update streaming.cancelAudit.test.ts`).toBeGreaterThanOrEqual(0);
      const body = mask(bodyAfter(streamingSrc.slice(at), "): void"));
      expect(body, `${name} must gate on the final's delta`).toContain("rec.delta.trim()");
    }
  });

  it("a final dropped at the flood cap owes its record from a link that holds no phrase text", () => {
    // An inline arrow in the final handler shares the dropped task's closure scope (target,
    // phraseClip), keeping up to two transcript-sized strings per link alive until the chain drains.
    const finalBody = mask(bodyAfter(streamingSrc, '"stream://final"'));
    expect(finalBody).toMatch(/!queued && uttRec\?\.id && uttRec\.delta\.trim\(\)\) oweDroppedInsert\(/);
    expect(finalBody).not.toMatch(/injectChain = injectChain\.then\([^;]*oweUtterance\(/);
    expect(mask(topLevelFunctions(streamingSrc).oweDroppedInsert)).toContain("insertCfg === cfg");
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
    for (const step of ["clipDirty && beganInjection", "giveClipboardBack(", "clipBooked = null", "flushClipByLang("]) {
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
    expect(link).toContain("giveClipboardBack(");
    for (const step of ["clipDirty && beganInjection", "clipDirty = false"]) {
      expect(link, `${step} must run inside the queued link`).toContain(step);
      const inLink = link.split(step).length;
      expect(boundary.split(step).length, `${step} must not run synchronously in the boundary`).toBe(inLink);
    }
  });

  it("the clipboard restore helper clears clipHoldsOurs before its awaited restore", () => {
    // A cancel-then-restart swaps the chain during the await; a clear AFTER it would wipe the
    // new session's own clipHoldsOurs (set by its first paste).
    const helper = mask(bodyAfter(streamingSrc, "function giveClipboardBack"));
    const clear = helper.indexOf("clipHoldsOurs = false");
    expect(clear, "the helper must clear clipHoldsOurs").toBeGreaterThanOrEqual(0);
    expect(helper.indexOf("restoreClipboardSnapshot(")).toBeGreaterThan(clear);
  });

  it("the separator task restores through the shared helper", () => {
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const task = mask(bodyAfter(boundary, "enqueueInject(async () =>"));
    const at = task.indexOf("if (beganInjection)");
    expect(at, "the separator's restore branch moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const branch = task.slice(at, task.indexOf("} else {", at));
    expect(branch).toContain("giveClipboardBack(");
  });

  it("every clipboard restore goes through giveClipboardBack", () => {
    // An inline copy can drift from the clear-before-await ordering (it already did once): the
    // helper body must be the only call site; the other occurrence is the import.
    const calls = mask(streamingSrc).split("restoreClipboardSnapshot(").length - 1;
    expect(calls, "call restoreClipboardSnapshot only from giveClipboardBack").toBe(1);
  });
});

describe("a stop or cancel during the start invoke", () => {
  // Status is "listening" and `capturing` true while startRecord/startStream is awaited, but Rust
  // stores the session only when the invoke returns (start_* reads the keyring first, which can sit
  // behind an unlock prompt). A gesture in that window found no session: the start then stored one
  // nobody stopped (mic open behind the chip), and a cancel discarded the PREVIOUS session's drain.
  const fns = topLevelFunctions(streamingSrc);

  it("stopLive defers to the post-invoke stop before touching anything", () => {
    const body = mask(fns.stopLive);
    const gate = body.indexOf("if (startInvokeInFlight)");
    expect(gate, "stopLive must open with the start-invoke deferral").toBeGreaterThanOrEqual(0);
    const deferral = bodyAfter(body, "if (startInvokeInFlight)");
    expect(deferral).toContain("stopRequestedDuringStart = true");
    expect(deferral).toContain("return");
    for (const step of ["autoStopMs = 0", "capturing = false", "stopStream()", "stopRecord()"]) {
      expect(body.indexOf(step), `${step} must come after the deferral`).toBeGreaterThan(gate);
    }
  });

  it("cancelLive leaves the Rust cancel to startLiveInner while the invoke is in flight", () => {
    const body = mask(fns.cancelLive);
    const owed = body.indexOf("const owedToStart = startInvokeInFlight");
    expect(owed, "cancelLive must read the start invoke at entry").toBeGreaterThanOrEqual(0);
    // Read before the teardown below resets `capturing`.
    expect(owed).toBeLessThan(body.indexOf("capturing = false"));
    expect(body).toContain("if (owedToStart) cancelDuringStartInvoke = {");
    const skip = body.indexOf("if (owedToStart) {");
    expect(skip, "the Rust cancel must be skipped for a starting session").toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(body.indexOf("cancelRecord("));
    expect(skip).toBeLessThan(body.indexOf("cancelStream("));
  });

  it("startLiveInner brackets the invoke and cancels the session a mid-invoke Cancel owed", () => {
    const body = mask(fns.startLiveInner);
    const begin = body.indexOf("startInvokeInFlight = true");
    expect(begin, "the flag must be raised before the invoke").toBeGreaterThanOrEqual(0);
    const invoke = body.indexOf("await startStream(");
    expect(begin).toBeLessThan(body.indexOf("await startRecord("));
    expect(begin).toBeLessThan(invoke);
    const end = body.indexOf("startInvokeInFlight = false", invoke);
    expect(end, "the flag must drop once the invoke returns").toBeGreaterThan(invoke);
    const owed = body.indexOf("if (owedCancel)", end);
    expect(owed, "the owed cancel must be honoured after the invoke").toBeGreaterThan(end);
    // …before the owed-stop check, which would otherwise stop (and save) a cancelled session.
    expect(owed).toBeLessThan(body.indexOf("void stopLive()"));
    // …and only while the session still captures: an error/close during the invoke already
    // tore it down, and a stop then would strand "finalizing…" over the error/idle chip.
    expect(body).toContain("if (capturing) void stopLive()");
    const branch = bodyAfter(body, "if (owedCancel)");
    expect(branch).toContain("cancelStream(true,");
    expect(branch).toContain("cancelRecord(true,");
    expect(branch).toContain("return");
    // The reject path drops the flag too, and a cancelled start never flashes its error.
    const reject = bodyAfter(body.slice(body.indexOf("void stopLive()")), "} catch (e)");
    expect(reject).toContain("startInvokeInFlight = false");
    const quiet = reject.indexOf("if (cancelDuringStartInvoke)");
    expect(quiet, "a cancelled start must skip flashError").toBeGreaterThanOrEqual(0);
    expect(quiet).toBeLessThan(reject.indexOf("flashError("));
  });
});

describe("a translating session re-caps its targets once the server's limit is known", () => {
  // startLiveInner caps the targets from whatever caps are cached; absent caps (a failed
  // earlier fetch) give the app's ceiling, and a list over TRANSLATION_MAX_TARGETS 422s every
  // phrase. The session's own forced caps probe must shrink them — before the warm early
  // return, or a session already proven warm would never be re-capped.
  it("startLiveInner's refreshCaps answer re-applies sendableTargets before the warm check", () => {
    const fn = topLevelFunctions(streamingSrc).startLiveInner;
    const probe = fn.indexOf("refreshCaps(backend, { force: true })");
    expect(probe, "startLiveInner must probe the caps").toBeGreaterThanOrEqual(0);
    const then = mask(bodyAfter(fn.slice(probe), ".then(() =>"));
    const recap = then.indexOf("shrinkToServerCap(tr)");
    expect(recap, "the probe's answer must re-cap tr.targets").toBeGreaterThanOrEqual(0);
    const guard = then.indexOf("if (sessionTranslation !== tr) return");
    expect(guard, "the caps answer is identity-checked").toBeGreaterThanOrEqual(0);
    expect(recap).toBeGreaterThan(guard);
    const warm = then.indexOf("if (tr.warm === true) return");
    expect(warm, "the warm check stays in the probe's answer").toBeGreaterThanOrEqual(0);
    expect(recap).toBeLessThan(warm);
    const shrink = topLevelFunctions(streamingSrc).shrinkToServerCap;
    expect(shrink).toContain("sendableTargets(tr.targets, tr.backendId)");
    expect(shrink).toContain("setDictation({ sessionTargets: capped })");
  });

  // The answer can land after the settle cleared the route (a quick stop on a slow /v1/me): it
  // may still shrink the dead session's list, but must not republish its route onto the idle chip.
  it("the re-cap republishes only while the session's route is published", () => {
    const shrink = mask(topLevelFunctions(streamingSrc).shrinkToServerCap);
    const guard = shrink.indexOf("if (useApp.getState().sessionTargets !== null)");
    expect(guard, "republish guarded on a live route").toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(shrink.indexOf("setDictation({ sessionTargets: capped })"));
  });
});

describe("a cancelled translating session's usage outcome", () => {
  const out = (o: Partial<Parameters<typeof translationOutcome>[0]>) =>
    translationOutcome({ skipped: false, asked: true, translated: false, abandoned: false, landed: false, ...o });

  it("maps the five branches", () => {
    expect(out({ skipped: true, translated: true })).toBe("aborted");
    expect(out({ asked: false, abandoned: true })).toBe("not_asked");
    expect(out({ translated: true, abandoned: true })).toBe("aborted");
    expect(out({ translated: true, abandoned: true, landed: true })).toBe("translated");
    expect(out({ translated: true })).toBe("translated");
    expect(out({ abandoned: true })).toBe("aborted");
    expect(out({})).toBe("kept_original");
  });

  it("a cancelled session that already typed its original kept it", () => {
    expect(out({ abandoned: true, landed: true })).toBe("kept_original");
  });

  it("cancelLive reports a user cancel as abandoned before it resets what landed", () => {
    const cancelLive = mask(topLevelFunctions(streamingSrc).cancelLive);
    // mask() blanks the "none" literal; every cancel is abandoned (wake from sleep keeps the
    // audio, not the text; the stuck-finalize watchdog claims its outcome before cancelling).
    const report = cancelLive.search(/\breportSessionOutcome\(\s+, true\)/);
    expect(report, "cancelLive must report a user cancel as abandoned").toBeGreaterThanOrEqual(0);
    expect(report).toBeLessThan(cancelLive.indexOf("sessionTyped = false"));
    expect(report).toBeLessThan(cancelLive.indexOf("sessionClipboard = false"));
    // deferSessionOutcome (behind reportSessionOutcome) feeds the flags into the abandoned branch.
    expect(mask(topLevelFunctions(streamingSrc).reportSessionOutcome)).toContain("deferSessionOutcome()?.(delivery, abandoned)");
    expect(mask(topLevelFunctions(streamingSrc).deferSessionOutcome)).toContain("landed: sessionTyped || sessionClipboard");
  });
});
