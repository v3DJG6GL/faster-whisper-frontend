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
import overlaySrc from "../../Overlay.tsx?raw";
import { incompleteFlashMessage, incompleteSurface, liveActivationOf, translationOutcome } from "./streaming";

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

/** The per-paste snapshot gate (masked: the string literal is blanked), shared by the phrase
 *  task and the separator. */
const SNAPSHOT_GATE = /t\.method ===\s+&& t\.restoreClipboard && !clipDirty && !t\.isSelf/;

/** Every top-level `function name(...) {...}` in a module, by name. Cached per source: each call
 *  scans the whole module, and a test calling it several times timed out under a loaded gate. */
const fnsCache = new Map<string, Record<string, string>>();
function topLevelFunctions(src: string): Record<string, string> {
  const hit = fnsCache.get(src);
  if (hit) return hit;
  const out: Record<string, string> = {};
  const re = /^(?:export )?(?:async )?function (\w+)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out[m[1]] = bodyAfter(src, m[0]);
  fnsCache.set(src, out);
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

  it("the hard-break carry is bounded like bankedDoc, and an overflow carries no records", () => {
    // A server looping final/boundary while nothing lands grew the carry by a whole document per
    // break, with no ceiling, and every joinCarry copied all of it.
    const link = bodyAfter(boundaryBody, "injectChain = injectChain.then(() =>");
    const remainder = link.indexOf("untypedRemainder(");
    const cap = link.search(/if \(rest\.trim\(\) && carryText\.length \+ carrySep\.length \+ rest\.length > MAX_BANKED_DOC\) \{\s+logLine\("warn",/);
    const append = link.indexOf("carryText = carryText ? joinCarry(");
    expect(cap, "the carry's ceiling moved — update streaming.cancelAudit.test.ts").toBeGreaterThan(remainder);
    expect(append).toBeGreaterThan(cap);
    // The overflow empties `rest`, so neither the append nor the records' move into the carry runs.
    expect(bodyAfter(link.slice(cap), "MAX_BANKED_DOC)")).toMatch(/\brest = "";/);
    expect(link.slice(cap)).toContain('{ kind: "break", carried: !!rest.trim() }');
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

  it("stopping a hands-free session drops the armed phrase-end timer but keeps its dirty flags", () => {
    // The timer's wait-for-the-server deferral is gated on capturing: left armed past stopLive it
    // pressed Enter after the previous phrase while the stopped utterance was still decoding, and
    // the drain's text then went into an empty field with a second Enter from the closed tail.
    const stop = mask(fns.stopLive);
    const clear = stop.indexOf("clearPhraseEndTimer(");
    expect(clear, "stopLive must cancel the phrase-end quiet timer").toBeGreaterThanOrEqual(0);
    expect(clear, "…before it awaits the stop").toBeLessThan(stop.indexOf("await "));
    // The closed tail owns the last phrase's Enter (phraseDirty) and the clipboard restore.
    expect(stop.slice(0, stop.indexOf("try {"))).not.toMatch(/clearPhraseEnd\(|phraseDirty =|clipDirty =/);
  });

  it("a final that lands after the stop marks the phrase dirty but does not re-arm the phrase-end timer", () => {
    // Re-armed during the drain, the timer skips its capture-gated deferral and presses Enter
    // while the stopped utterance is still decoding — the split stopLive's timer clear prevents.
    const grew = mask(bodyAfter(finalBody, "if (grew)"));
    expect(grew, "a growing final still marks the phrase for the closed tail's Enter").toMatch(
      /^\{\s*phraseDirty = true;/,
    );
    const bumps = grew.split("\n").filter((l) => l.includes("bumpPhraseEnd("));
    expect(bumps.length, "while capturing a growing final still (re)arms the quiet timer").toBeGreaterThan(0);
    for (const line of bumps) expect(line, "the final's bump must be gated on capturing").toMatch(/\bcapturing\b/);
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
    expect(skip).toBeLessThan(enter.indexOf("pressReturn("));
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

  it("a phrase the clipboard branch copied disarms the per-phrase and tail Enter too", () => {
    // A blocked / non-editable / clipboard-rule window: the phrase is copied, not typed, and the
    // Enter tasks resolve the window focused when they run — the one the user moved to for the
    // paste. Only the in-queue flag can stop that Return.
    const copied = mask(bodyAfter(finalBody, "if (!t.isSelf && landed)"));
    expect(copied).toContain("signalInsert(");
    expect(copied).toContain("lastPhraseDiverted = true;");
  });

  it("the per-phrase and hard-break Enter go only into the app the phrase was typed into", () => {
    // Focus that moved on between the typed phrase and its Enter got the Return: it submitted the
    // user's own draft in that window, and the dictated message never got its Enter.
    const enter = mask(fns.enqueueAutoEnter);
    const owed = enter.indexOf("if (t.appId !== lastTypedApp || !gapOwedApps.has(t.appId)) return;");
    expect(owed, "auto-Enter task must stand down in an app that owes no Return").toBeGreaterThanOrEqual(0);
    expect(owed).toBeLessThan(enter.indexOf("pressReturn("));
    const boundary = mask(bodyAfter(boundaryBody, "enqueueInject(async () =>"));
    expect(boundary).toMatch(/if \(dirtyAtBreak && t\.appId === lastTypedApp && gapOwedApps\.has\(t\.appId\)\) await pressReturn\(t, cfg\);/);
  });

  it("the hard-break separator goes only into the app the phrase was typed into", () => {
    // With Enter off, the separator took the window focused at the hard break: a " " landed in
    // the user's own draft there, and a newline separator's Return submitted it.
    const boundary = mask(bodyAfter(boundaryBody, "enqueueInject(async () =>"));
    const autoEnter = boundary.indexOf("if (t.autoEnter)");
    const owed = boundary.indexOf("if (t.appId !== lastTypedApp || !gapOwedApps.has(t.appId)) return;", autoEnter);
    expect(owed, "separator must stand down in an app that owes no gap").toBeGreaterThan(autoEnter);
    expect(owed).toBeLessThan(boundary.indexOf("const sendSepText"));
    expect(owed).toBeLessThan(boundary.indexOf("const parts = sep"));
  });

  it("the Enter and the separator follow the LAST typed phrase's app, not every app still owed", () => {
    // gapOwedApps holds every app typed into since its last Return. With Enter off and a plain
    // separator nothing pays it, so after phrases in A then B, clicking back into A to write a
    // draft got the separator — or a newline separator's Return submitting that draft — at the
    // next hard break. The extra key is the app the last typed phrase went into.
    expect(mask(streamingSrc)).toMatch(/\nlet lastTypedApp: string \| null \| undefined;/);
    // Set only by a phrase typed into the field, right where it starts owing its gap.
    const delivered = mask(bodyAfter(finalBody, "if (delivered) "));
    expect(delivered).toMatch(/gapOwedApps\.add\(t\.appId\);\s+lastTypedApp = t\.appId;/);
    expect(mask(bodyAfter(finalBody, "if (delivered && diverted) "))).not.toContain("lastTypedApp");
    expect(mask(streamingSrc).match(/\blastTypedApp = t\.appId;/g) ?? [], "the one set site").toHaveLength(1);
    // Every start and abandon resets it with the Set.
    expect(mask(fns.clearPhraseEnd)).toMatch(/gapOwedApps\.clear\(\);\s+lastTypedApp = undefined;/);
    // All three Return/separator producers test it.
    expect(mask(fns.enqueueAutoEnter)).toContain("t.appId !== lastTypedApp");
    const boundary = mask(bodyAfter(boundaryBody, "enqueueInject(async () =>"));
    expect(boundary.match(/lastTypedApp/g) ?? []).toHaveLength(2);
  });

  it("a translated block's gap follows the field's last typed phrase, not the typed baseline", () => {
    // `injectedText` is emptied by a hard break (the next block glued onto the last line) and
    // survives a landed Return (the next block opened with three more Returns).
    const final = mask(finalBody);
    // Owed per app: a block typed into another (focus moved across a hard break) opens that
    // app's empty field with no Returns, and going back still owes it in the first one (A, B, A).
    expect(final).toMatch(/\(gapOwedApps\.has\(t\.appId\) \? PHRASE_GAP :/);
    expect(mask(streamingSrc)).toMatch(/const gapOwedApps = new Set</);
    expect(final).not.toMatch(/injectedText\.length > 0[^;]*PHRASE_GAP/);
    // Owed by a phrase typed into the field — not by one diverted to the clipboard.
    const delivered = mask(bodyAfter(finalBody, "if (delivered) "));
    const typed = delivered.indexOf("sessionTyped = true;");
    expect(typed, "the typed branch of the delivered block").toBeGreaterThanOrEqual(0);
    expect(delivered.slice(typed)).toMatch(/^sessionTyped = true;\s+lastPhraseDiverted = false;\s+if \(opensBlock\) \{\s+gapOwedApps\.add\(t\.appId\);/);
    expect(mask(bodyAfter(finalBody, "if (delivered && diverted) "))).not.toContain("gapOwedApps");
    // Paid by a Return that landed: the quiet-timer Enter, and the hard break's Enter or newline
    // separator — all through pressReturn, which pays after its injectText, under the session
    // token, and only when it landed in that app (a Return in app B does not end A's phrase).
    const settled = /if \(insertCfg === cfg && landed && !diverted\) gapOwedApps\.delete\(t\.appId\);/;
    expect(mask(streamingSrc).match(/gapOwedApps\.(?:delete|clear)\(/g) ?? [], "the one pay site, or the reset").toHaveLength(2);
    const press = mask(fns.pressReturn);
    expect(press.match(new RegExp(settled.source, "g")) ?? []).toHaveLength(1);
    expect(press.search(settled)).toBeGreaterThan(press.indexOf("injectText("));
    expect(mask(fns.enqueueAutoEnter)).toContain("pressReturn(t, cfg)");
    const boundary = mask(bodyAfter(boundaryBody, "enqueueInject(async () =>"));
    expect(boundary.match(/pressReturn\(t, cfg\)/g) ?? []).toHaveLength(2);
    expect(boundary).not.toContain("autoEnter: true");
    // Never before a session's first phrase: every start and abandon resets it.
    expect(mask(fns.clearPhraseEnd)).toContain("gapOwedApps.clear();");
  });

  it("a translated final that only adds whitespace types nothing, not the gap alone, and leaves the gap owed", () => {
    // A closing final that only appends the server's output_suffix ("\n" or " ") translates to
    // nothing (`block` is empty). Normalised to gap + block it typed PHRASE_GAP alone — three bare
    // Returns, empty submits in a chat box. Typed as-is, its "\n" was still a Return (a submit)
    // that left the gap owed, so the next block opened four line breaks down.
    const final = mask(finalBody);
    expect(final).toMatch(/const block = phrase\.text\.trim\(\);\s+const opensBlock = !sessionTranslation \|\| block !== \s+;\s+const typeOut = sessionTranslation\s+\? \(block \? \(gapOwedApps\.has\(t\.appId\) \? PHRASE_GAP :\s+\) \+ block :\s+\)\s+: phrase\.text;/);
    // The gap is never typed without a block after it.
    expect(final).not.toMatch(/sessionTranslation\s+\? \(gapOwedApps\.has\(t\.appId\) \? PHRASE_GAP/);
    // It neither owes a gap nor moves the Enter's app: only a phrase that opens a block does.
    const delivered = mask(bodyAfter(finalBody, "if (delivered) "));
    expect(delivered).toMatch(/if \(opensBlock\) \{\s+gapOwedApps\.add\(t\.appId\);\s+lastTypedApp = t\.appId;\s+\}/);
    expect(delivered.match(/gapOwedApps\.add\(/g) ?? []).toHaveLength(1);
    expect(delivered.match(/lastTypedApp = /g) ?? []).toHaveLength(1);
    // …nor pays one: the only pay site stays pressReturn's landed Return.
    expect(final).not.toMatch(/gapOwedApps\.delete\(/);
    // …nor joins the translated document: a whitespace phrase comes back untranslated…
    const translate = streamingSrc.slice(streamingSrc.indexOf("async function maybeTranslate("), streamingSrc.indexOf("async function translatePhrase("));
    expect(translate).toContain("if (!tr || !text.trim()) return { text, translated: false };");
    // …and only a translated phrase books there.
    expect(delivered).toMatch(/if \(phrase\.translated\) \{\s+sessionPhraseContext\.push\(body\);\s+sessionTranslatedText = /);
  });

  it("a translated whitespace-only final hands injectText an empty text, gap owed or not", () => {
    // Runs the phrase's seam rule itself (the statements from `block` to `typeOut`, plain JS) on
    // the output_suffix finals, into an app that owes no gap and into one that owes it.
    const start = finalBody.indexOf("const block = phrase.text.trim();");
    expect(start, "the phrase's seam rule moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const end = finalBody.indexOf(": phrase.text;", start) + ": phrase.text;".length;
    const seam = new Function(
      "phrase", "sessionTranslation", "gapOwedApps", "t", "PHRASE_GAP",
      `${finalBody.slice(start, end)}\nreturn { typeOut, opensBlock };`,
    ) as (phrase: { text: string }, sessionTranslation: boolean, gapOwedApps: Set<string>, t: { appId: string }, gap: string) => { typeOut: string; opensBlock: boolean };
    const gap = "\n\n\n";
    for (const suffix of ["\n", " ", " \n"]) {
      for (const owed of [new Set<string>(), new Set(["app"])]) {
        const out = seam({ text: suffix }, true, owed, { appId: "app" }, gap);
        expect(out.typeOut, `${JSON.stringify(suffix)} with ${owed.size ? "a" : "no"} gap owed`).toBe("");
        expect(out.opensBlock).toBe(false);
      }
    }
    // A real block still gets the gap only when it is owed; an untranslated phrase is untouched.
    expect(seam({ text: " Hallo\n" }, true, new Set(["app"]), { appId: "app" }, gap).typeOut).toBe(gap + "Hallo");
    expect(seam({ text: " Hallo\n" }, true, new Set(), { appId: "app" }, gap).typeOut).toBe("Hallo");
    expect(seam({ text: "\n" }, false, new Set(["app"]), { appId: "app" }, gap).typeOut).toBe("\n");
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
    // mask() blanks the delivery literals; bookFailedEnd makes a failed copy abandoned.
    const settle = body.search(/\bbookFailedEnd\(settleOutcome, onClipboard \?\s+:\s+\)/);
    expect(settle, "the copy's answer settles the outcome").toBeGreaterThan(body.indexOf("recoverUnguarded("));
    // Both branches: before the superseded check returns early.
    expect(settle).toBeLessThan(body.indexOf("if (superseded)"));
    expect(mask(streamingSrc)).not.toMatch(/\brecovered:/);
  });

  // stream://error and the stopLive reject leave no `closed` behind (it bails on status "error"), so
  // nothing else books them: without their own booking Statistics showed the session as Unreported.
  for (const [name, get] of [
    ["the stream-error handler", () => mask(bodyAfter(streamingSrc, 'reg<string>("stream://error"'))],
    ["the stopLive reject", () => mask(bodyAfter(fns.stopLive, "} catch (e)"))],
  ] as const) {
    it(`${name} books its usage outcome — the copy's answer, or what already landed`, () => {
      const body = get();
      const claim = body.indexOf("const settleOutcome = deferSessionOutcome();");
      expect(claim, `${name} claims the outcome`).toBeGreaterThanOrEqual(0);
      // Claimed before the teardown, so a cancel during the error linger can't book first.
      expect(claim).toBeLessThan(body.indexOf("insertCfg = null"));
      expect(claim).toBeLessThan(body.indexOf("flashError("));
      const copy = body.indexOf("recoverUnguarded(");
      expect(claim).toBeLessThan(copy);
      // Nothing to recover → what landed (live phrases, bookFailedEnd's default), settled right away.
      const sync = body.indexOf("if (!pending) bookFailedEnd(settleOutcome);", claim);
      expect(sync, "the no-text branch settles with what landed, synchronously").toBeGreaterThan(claim);
      expect(sync).toBeLessThan(body.indexOf("insertCfg = null"));
      expect(sync).toBeLessThan(body.indexOf("flashError("));
      // Text to recover → the copy's answer, in both branches (before the failed copy returns).
      const settle = body.search(/\bbookFailedEnd\(settleOutcome, onClipboard \?\s+:\s+\)/);
      expect(settle, "the copy's answer settles the outcome").toBeGreaterThan(copy);
      expect(settle).toBeLessThan(body.indexOf("if (!onClipboard) return"));
    });
  }

  it("teardownAfterFatalInject books what landed before the failed phrase", () => {
    const body = mask(fns.teardownAfterFatalInject);
    const report = body.indexOf("bookFailedEnd(deferSessionOutcome());");
    expect(report, "teardownAfterFatalInject books the outcome").toBeGreaterThanOrEqual(0);
    expect(report).toBeLessThan(body.indexOf("insertCfg = null"));
  });

  it("every failure end books abandoned exactly when nothing landed", () => {
    // The rule lives in one helper so the failure paths cannot drift apart again: a kept-error
    // settle (the stop-mode failed insert or sink skip, whose recovery copy failed) used to book
    // its lost text as a delivered translation while every sibling booked it "aborted".
    expect(mask(fns.bookFailedEnd)).toContain("settle?.(delivery, delivery ===");
    expect(mask(fns.settleIdle)).toContain("if (keepError) bookFailedEnd(deferSessionOutcome())");
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

  it("the incomplete flash keeps the notice's cause and says nothing was transcribed", () => {
    // stream://incomplete carries several causes; a restart or a lost connection after Stop
    // must not be reported as a slow server.
    expect(incompleteFlashMessage("The server did not finish the transcript in time; the last phrase may be missing.")).toBe(
      "The server did not finish the transcript in time; nothing was transcribed.",
    );
    expect(incompleteFlashMessage("The server restarted during dictation — the last phrase may be missing.")).toBe(
      "The server restarted during dictation; nothing was transcribed.",
    );
    expect(
      incompleteFlashMessage("The connection to the server was lost (connection reset) — the last phrase may be missing."),
    ).toBe("The connection to the server was lost (connection reset); nothing was transcribed.");
    // A notice with no cause of its own keeps the old wording.
    expect(incompleteFlashMessage(" — the last phrase may be missing.")).toBe(
      "The server didn’t finish the transcript in time; nothing was transcribed.",
    );
    expect(mask(bodyAfter(streamingSrc, "function settleIdle("))).toContain("incompleteFlashMessage(sessionIncomplete)");
    // The overlay's screen-reader line names no cause either: the note stands for all of them.
    expect(overlaySrc).not.toContain("did not finish the transcript in time");
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

  it("a failed end-of-session insert settles its bookkeeping before a re-press can start over the error", () => {
    // "error" is not a busy status: a re-press during the visibility wait replaced insertCfg, and
    // the timer's identity guard then skipped the failed session's History capture and outcome.
    const settle = mask(bodyAfter(streamingSrc, "function settleToIdleAfterInjection("));
    const drained = settle.indexOf("injectChain.then(");
    const timer = settle.indexOf("setTimeout(");
    const now = settle.search(/if \(insertCfg === cfg && useApp\.getState\(\)\.status ===\s+\) \{\s*settleIdle\(true\);\s*return;/);
    expect(drained).toBeGreaterThanOrEqual(0);
    expect(now, "the error settle must run in the drained callback").toBeGreaterThan(drained);
    expect(now, "…before the visibility wait").toBeLessThan(timer);
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
    // A translated session's typeOut carries the field's PHRASE_GAP; the recovery copy replaces
    // the clipboard, so it must not open with three blank lines (the clipboard branch's rule).
    const copyArgs = streamingSrc.slice(copy + "recoverToClipboard(".length, reason).trim();
    expect(copyArgs.startsWith("typeOut"), "a translated recovery copy must drop the phrase gap").toBe(false);
    // The same clipboard form Rust's writes get (see the next test): one rule, not two spellings.
    expect(copyArgs).toContain("clipboardText ?? typeOut");
  });

  it("a diverted or recovered translated block reaches the clipboard bare, in Rust's one write", () => {
    // Rust's divert / recovery arms used to put the text they were handed — the gapped typeOut —
    // on the clipboard; pasted, it opened with three blank lines. The FIELD keeps its gap, so the
    // live insert hands Rust the bare block as its clipboard form (`clipboardText`) and every
    // divert / recovery arm writes that instead.
    const finalBody = bodyAfter(streamingSrc, '"stream://final"');
    const final = mask(finalBody);
    expect(final).toMatch(/const typeOut = sessionTranslation\s+\? \(block \? \(gapOwedApps\.has\(t\.appId\) \? PHRASE_GAP :\s+\) \+ block/);
    // The live phrase insert: typeOut into the field, the bare block for the clipboard — only
    // when the two differ (omitted = Rust's old behaviour, the clipboard gets `text`).
    const call = final.search(/injectText\(\{ text: typeOut, clipboardText,/);
    expect(call, "the live insert must pass the bare block as its clipboard form").toBeGreaterThanOrEqual(0);
    // Hoisted above the try, so the catch's recovery copy reads the same form.
    // An untranslated phrase's clipboard form drops its seam space; a whitespace-only form falls back to text.
    expect(final.slice(0, call)).toMatch(/const clipForm = sessionTranslation \? block : typeOut\.trim\(\);\s*const clipboardText = clipForm && clipForm !== typeOut \? clipForm : undefined;\s*const spacingOnly = !typeOut\.trim\(\);\s*try \{\s*\(\{ landed, diverted \} = await $/);
    // …and nothing after it copies the phrase a second time. A JS re-copy after the await never
    // ran for an error-abort recovery (the teardown nulls insertCfg first) and, for a divert,
    // left a gapped duplicate in the clipboard history. The failed-insert catch's recovery copy
    // is the one clipboard write left, and it already copies the bare block.
    const after = final.slice(call);
    expect(after).not.toMatch(/recoverUnguarded\(|recoverTextToClipboard\(|copyForTarget\(/);
    expect(after.match(/recoverToClipboard\(/g) ?? []).toHaveLength(1);
    const delivered = bodyAfter(finalBody, "if (delivered) ");
    expect(delivered).not.toMatch(/await /);
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

  it("a per-utterance clip finds its record by ordinal, also after later finals or a break", () => {
    // Rust writes each clip on its own thread, so it can land after the next utterance's final
    // (lastUtterance replaced) or a break (lastUtterance nulled): pairing it with lastUtterance
    // dropped it, leaving the record without its audio and the .wav orphaned.
    const recording = mask(bodyAfter(streamingSrc, '"stream://recording"'));
    expect(recording).toContain("routeUtteranceClip(utteranceByOrdinal, ordinal,");
    expect(recording).not.toContain("lastUtterance");
    // Past the signature: its return type is the first brace topLevelFunctions sees.
    const at = streamingSrc.indexOf("function recordUtteranceFinal(");
    expect(at, "recordUtteranceFinal moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(mask(bodyAfter(streamingSrc.slice(at), "delta: string }"))).toContain("utteranceByOrdinal.set(ordinal, lastUtterance)");
    // Only the session's end forgets an utterance whose clip is still on its way.
    expect(mask(bodyAfter(streamingSrc, '"stream://boundary"'))).not.toContain("utteranceByOrdinal");
    expect(mask(topLevelFunctions(streamingSrc).resetUtteranceHistory)).toContain("utteranceByOrdinal.clear()");
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

  it("a release final after the pause re-copies the closed clipboard window with its held-back words", () => {
    // The server releases held words ("neue" before "Zeile", a trailing "Komma") only after a hard
    // break, its 5 s idle release or a stop — long after the quiet timer moved the baseline and
    // closed the window. The release then replaced "Das ist das" on the clipboard with "neue."
    // alone, and booked its translation as a window of its own.
    const finalBody = bodyAfter(streamingSrc, '"stream://final"');
    const boundaryBody = bodyAfter(streamingSrc, '"stream://boundary"');
    const timer = mask(fns.bumpPhraseEnd);
    // The timer keeps the window it closes, from the baseline BEFORE it moves, and only when the
    // session has seen ordinals (an old server's finals all look like releases).
    const keep = timer.indexOf("clipClosed = closing");
    expect(keep, "the timer must record the window it closes").toBeGreaterThanOrEqual(0);
    expect(timer.indexOf("baseline: clipBaseline")).toBeLessThan(timer.indexOf("clipBaseline = committedDoc"));
    expect(timer).toMatch(/clipOrdinalSeen\s+\?\s+\{ baseline: clipBaseline, booked: null, byLang: undefined, landed: false \}/);
    expect(keep).toBeLessThan(timer.indexOf("clipBaseline = committedDoc"));
    // Its queued close link records what it closed before closing it.
    const link = mask(bodyAfter(fns.bumpPhraseEnd, "injectChain = injectChain.then(async () =>"));
    expect(link).toMatch(/closing\.booked = clipBooked;\s+closing\.byLang = clipByLang;\s+closing\.landed = clipLanded;\s+\}\s+clipBooked = null;\s+clipLanded = false;\s+flushClipByLang\(\);/);
    // A release final (no ordinal) copies from the closed window's baseline and leaves it closed.
    const final = mask(finalBody);
    expect(final).toMatch(/const reopen = ordinal === null \? clipClosed : null;/);
    expect(final).toMatch(/if \(ordinal !== null\) clipClosed = null;/);
    expect(final).toMatch(/const plainStartRaw = commonPrefixLen\(clipBaseline, committedDoc\);\s+const reopenStartRaw = reopen \? commonPrefixLen\(reopen\.baseline, committedDoc\) : plainStartRaw;\s+if \(reopen\) clipBaseline = committedDoc;/);
    // Its translation REPLACES the closed window's booking and per-language tracks, then closes
    // the window again with the new booking recorded for a further release.
    const booking = mask(bodyAfter(finalBody, "if (translated && !t.isSelf && landed) "));
    const restore = booking.indexOf("clipBooked = live.booked;");
    expect(restore, "a reopening release must restore the closed window's booking").toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(booking.indexOf("clipBooked ??="));
    expect(booking).toContain("if (byLang) unbookClipByLang(live.byLang);");
    const reclose = booking.indexOf("live.booked = clipBooked;");
    expect(reclose).toBeGreaterThan(booking.indexOf("if (byLang) clipByLang = byLang;"));
    expect(booking.slice(reclose)).toMatch(/^live\.booked = clipBooked;\s+if \(byLang\) live\.byLang = byLang;\s+\}\s+clipBooked = null;\s+flushClipByLang\(\);/);
    expect(finalBody).toContain('bookUtteranceInsert(uttRec, "clipboard", phraseClip, { text: clipOut, translated, byLang }, !!live);');
    // Its History record takes the whole window's translation when the window is exactly its text.
    const book = mask(bodyAfter(streamingSrc.slice(streamingSrc.indexOf("function bookUtteranceInsert(")), "): void"));
    expect(book).toMatch(/const whole =\s+reopened && !own && phrase\.translated && sessionTranslation != null && sent\.trim\(\) === \(r\.result\?\.text \?\?\s+\)\.trim\(\);/);
    expect(book).toMatch(/\.\.\.\(whole\s+\? \{\s+translatedText: phrase\.text\.trim\(\),/);
    // New committed speech ends the chance (the ordinal final above), so does a hard break;
    // every start and abandon.
    expect(mask(boundaryBody)).toMatch(/clipBaseline =\s+;\s+clipClosed = null;/);
    expect(mask(fns.clearPhraseEnd)).toMatch(/clipClosed = null;\s+clipOrdinalSeen = false;/);
  });

  it("an utterance that opens in the pause and ends dropped keeps the closed window reopenable", () => {
    // A cough, a breath or an "ähm" the server strips opens an utterance (`open`, maybe a
    // partial) and ends `dropped`: no final, no new text, the held words still held. Clearing
    // clipClosed on that `open` or partial sent the later release back to copying "neue." alone
    // over the phrase. Only an ordinal final — real new text — may end the chance: the server
    // releases only between utterances, so new speech always lands that final first.
    expect(mask(bodyAfter(streamingSrc, '"stream://partial"'))).not.toContain("clipClosed");
    expect(mask(bodyAfter(streamingSrc, '"stream://utterance"'))).not.toContain("clipClosed");
    const final = mask(bodyAfter(streamingSrc, '"stream://final"'));
    expect(final.match(/clipClosed = null;/g)).toEqual(["clipClosed = null;"]);
    expect(final).toMatch(/if \(ordinal !== null\) clipClosed = null;/);
  });

  it("a release reopens only a closed window a clipboard copy landed in, not a typed one", () => {
    // A typed window (paste/direct) closed by the pause, then focus on a clipboard-routed app
    // before the release: reopening copied the already-typed phrase again and re-booked its
    // translation on top of the typed path's booking — History and every track held it twice.
    const finalBody = bodyAfter(streamingSrc, '"stream://final"');
    // The pause's link records whether a copy landed in the window it closes, and resets the flag
    // with the window — as does a hard break's link and every start and abandon.
    expect(streamingSrc).toMatch(/type ClosedClipWindow = \{[^}]*landed: boolean;[^}]*\};/);
    const link = mask(bodyAfter(fns.bumpPhraseEnd, "injectChain = injectChain.then(async () =>"));
    expect(link).toContain("closing.landed = clipLanded;");
    expect(link.indexOf("clipLanded = false;")).toBeGreaterThan(link.indexOf("closing.landed = clipLanded;"));
    const boundaryLink = mask(bodyAfter(bodyAfter(streamingSrc, '"stream://boundary"'), "injectChain = injectChain.then(() =>"));
    expect(boundaryLink).toMatch(/clipBooked = null;\s+clipLanded = false;/);
    expect(mask(fns.clearPhraseEnd)).toContain("clipLanded = false;");
    // Only a landed clipboard copy outside a release marks the window.
    const task = mask(bodyAfter(finalBody, "if (useClipboard) "));
    expect(task.match(/clipLanded = true;/g)).toEqual(["clipLanded = true;"]);
    expect(mask(bodyAfter(task, "if (!t.isSelf && landed) "))).toMatch(/^\{\s+if \(!reopen\) clipLanded = true;/);
    // The task decides in the queue, after that link, which window it copies and books.
    expect(task).toMatch(
      /const live = reopen\?\.landed \? reopen : null;\s+const phraseClip = live \? reopenClip : plainClip;\s+const clipFrom = Math\.max\(0, \(live \? reopenStartRaw : plainStartRaw\) - lead\);/,
    );
    expect(task.indexOf("const live =")).toBeLessThan(task.indexOf("translatePhrase(phraseClip"));
    const booking = mask(bodyAfter(task, "if (translated && !t.isSelf && landed) "));
    expect(booking).not.toContain("reopen.booked");
    expect(booking).not.toContain("reopen.byLang");
    // A release that did not reopen still closes its own window: the baseline already moved.
    expect(booking).toMatch(/if \(reopen\) \{\s+if \(live\) \{[^}]*\}\s+clipBooked = null;\s+flushClipByLang\(\);\s+\}/);
    expect(mask(finalBody)).not.toMatch(/\bconst phraseClip = committedDoc/);
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
    // The separator task is queued too (enqueueInject): its own restore may clear the debt it paid.
    const sepTask = mask(bodyAfter(bodyAfter(streamingSrc, '"stream://boundary"'), "enqueueInject(async () =>"));
    for (const step of ["clipDirty && beganInjection", "clipDirty = false"]) {
      expect(link, `${step} must run inside the queued link`).toContain(step);
      const queued = link.split(step).length + sepTask.split(step).length - 1;
      expect(boundary.split(step).length, `${step} must not run synchronously in the boundary`).toBe(queued);
    }
  });

  it("the separator task restores through the shared helper", () => {
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const task = mask(bodyAfter(boundary, "enqueueInject(async () =>"));
    const at = task.indexOf("&& landed && beganInjection)");
    expect(at, "the separator's restore branch moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(bodyAfter(task, "&& landed && beganInjection)")).toContain("giveClipboardBack(");
  });

  it("the separator withholds itself instead of diverting to the clipboard", () => {
    // A Rust divert (chord still held, focus moved) used to make a lone " " the clipboard's
    // persistent owner over the user's copy; a separator has nothing to recover, so it opts out.
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const task = mask(bodyAfter(boundary, "enqueueInject(async () =>"));
    const call = task.indexOf("injectText({ text: part,");
    expect(call, "the separator's injectText moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(task.slice(call, task.indexOf("});", call))).toContain("withholdOnDivert: true");
    // Only the separator and a whitespace-only phrase (next test): the auto-Enter calls (empty
    // text) and every phrase with words keep the divert.
    expect(mask(streamingSrc).match(/withholdOnDivert/g) ?? []).toHaveLength(2);
  });

  it("a whitespace-only live phrase withholds itself instead of diverting, and is never recovered to the clipboard", () => {
    // A final that only appends the server's output_suffix has no clipboard form, so Rust's fell
    // back to the bare "\n" or " ": a divert made it the clipboard's owner over the user's copy
    // (or the block diverted just before it), and a failed insert's recovery copied it with an
    // "it's on the clipboard" flash. A word-less "?" is not whitespace and keeps both.
    const final = mask(bodyAfter(streamingSrc, '"stream://final"'));
    const call = final.indexOf("injectText({ text: typeOut, clipboardText,");
    expect(call, "the live phrase insert moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(final.slice(0, call)).toMatch(/const spacingOnly = !typeOut\.trim\(\);/);
    expect(final.slice(call, final.indexOf("}));", call))).toMatch(/, withholdOnDivert: spacingOnly $/);
    // The catch tears down as before, without the copy (or its flash) for whitespace.
    const catchBody = bodyAfter(final.slice(call), "catch (e) ");
    expect(catchBody).toMatch(/const recoverable = !spacingOnly && await recoverToClipboard\(/);
    expect(catchBody).toMatch(/recoverable\s+\? t\.method/);
    expect(catchBody).toContain("teardownAfterFatalInject();");
  });

  it("a separator whose paste fails gives the user's copy back from the snapshot", () => {
    // The separator passes restoreClipboard: false, so Rust's failed-paste restore has nothing to
    // put back and the call rejects: without a catch the `landed` gate never ran and a lone " "
    // sat on the clipboard over the user's copy.
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const task = mask(bodyAfter(boundary, "enqueueInject(async () =>"));
    const call = task.indexOf("injectText({ text: part,");
    expect(call, "the separator's injectText moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const tryAt = task.lastIndexOf("try {", call);
    expect(tryAt, "the separator's injectText must sit inside a try").toBeGreaterThanOrEqual(0);
    expect(task.slice(tryAt, call), "nothing but the call between the try and the separator inject").not.toContain("}");
    const catchBody = bodyAfter(task.slice(call), "} catch (e)");
    const guard = catchBody.indexOf("if (insertCfg !== cfg) return false;");
    expect(guard, "the catch must check the session token").toBeGreaterThanOrEqual(0);
    const restore = catchBody.indexOf("giveClipboardBack(");
    expect(restore, "the catch must restore after the session-token check").toBeGreaterThan(guard);
    // Only from a snapshot: the restore's own condition asks for one.
    const cond = catchBody.slice(catchBody.lastIndexOf("if (", restore), restore);
    expect(cond).toContain("beganInjection");
    // The write may not have happened: never re-send.
    expect(catchBody).not.toContain("injectText(");
  });

  it("a separator paste takes its own snapshot, like each phrase", () => {
    // The separator used to restore the snapshot taken before the LAST phrase: after the quiet
    // timer gave the clipboard back, a copy the user made before the hard break was replaced by
    // that older content — on a landed separator and from the catch alike.
    const boundary = bodyAfter(streamingSrc, '"stream://boundary"');
    const task = mask(bodyAfter(boundary, "enqueueInject(async () =>"));
    const call = task.indexOf("injectText({ text: part,");
    expect(call, "the separator's injectText moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    const begin = task.lastIndexOf("beginInjection(", call);
    expect(begin, "the separator must snapshot the clipboard before its paste").toBeGreaterThanOrEqual(0);
    // The phrase task's gate: never snapshot our own text as the user's original.
    const gate = task.slice(task.lastIndexOf("if (", begin), begin);
    expect(gate).toMatch(SNAPSHOT_GATE);
    // The awaited snapshot is a gap a cancel can land in: re-check the session token before pasting.
    const between = task.slice(begin, call);
    expect(between).toContain("beganInjection = true;");
    expect(between, "a session-token check between the snapshot and the separator paste").toContain("if (insertCfg !== cfg) return false;");
  });

  it("the phrase task takes its snapshot through the same gate", () => {
    // A JS "the clipboard holds our text" flag cannot see a copy the user made since: only a
    // paste still owed a restore (clipDirty) skips the read; Rust's is_own_injected decides the rest.
    const final = mask(bodyAfter(streamingSrc, '"stream://final"'));
    const begin = final.indexOf("await beginInjection()");
    expect(begin, "the phrase task's snapshot moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(final.slice(final.lastIndexOf("if (", begin), begin)).toMatch(SNAPSHOT_GATE);
    expect(streamingSrc).not.toContain("clipHoldsOurs");
  });

  it("a snapshot latches beganInjection only for the session that took it", () => {
    // A cancel-then-restart during the awaited read: the late latch handed session B a restore
    // debt (a spurious injecting tail, and a snapshot-clear on its behalf).
    const src = mask(streamingSrc);
    const latches = src.match(/await beginInjection\(\);\s+if \(insertCfg === cfg\) beganInjection = true;/g) ?? [];
    expect(latches).toHaveLength(2);
    expect(src.match(/await beginInjection\(\);/g) ?? []).toHaveLength(2);
  });

  it("a multi-line separator presses a Return per line break and sends the text between", () => {
    // "\n\n" (a blank line) used to press ONE Return, and ".\n" lost its "." — while the carry
    // and the Live dictation preview have the separator exactly as written.
    const boundary = mask(bodyAfter(bodyAfter(streamingSrc, '"stream://boundary"'), "enqueueInject(async () =>"));
    const loop = boundary.indexOf("for (let i = 0; i < parts.length; i++)");
    expect(loop, "the separator loop moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    // A CRLF or lone CR is one break (as Rust's sanitize_injected and the carry have it), not a
    // "\r" typed as a line break plus a Return.
    // (mask blanks the regex literal and the strings; the raw source pins the pattern.)
    expect(boundary).toMatch(/const parts = sep\.replace\(\s+,\s+\)\.split\(\s+\);/);
    expect(streamingSrc).toContain('const parts = sep.replace(/\\r\\n?/g, "\\n").split("\\n");');
    expect(boundary).not.toMatch(/sep\.includes\(/);
    const body = bodyAfter(boundary.slice(loop), ")");
    // A Return before every part after the first, each stopping the rest when it did not land.
    expect(body).toMatch(/if \(i > 0 && \(!\(await pressReturn\(t, cfg\)\) \|\| insertCfg !== cfg\)\) return;/);
    expect(body).toMatch(/if \(parts\[i\] && \(!\(await sendSepText\(parts\[i\]\)\) \|\| insertCfg !== cfg\)\) return;/);
    expect(mask(topLevelFunctions(streamingSrc).pressReturn)).toMatch(/return landed && !diverted;/);
  });

  it("a landed separator's restore pays the debt, so the backstop does not restore it again", () => {
    // The quiet timer's restore was dropped by the boundary, so clipDirty was still set: the
    // separator restored after its paste and then the backstop link restored the same snapshot.
    const boundary = mask(bodyAfter(streamingSrc, '"stream://boundary"'));
    expect(boundary).toMatch(
      /&& landed && beganInjection\) \{\s+await giveClipboardBack\(\);\s+if \(insertCfg === cfg\) clipDirty = false;\s+\}/,
    );
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
    // A cancel books what already landed (live phrases are in the target app), else Nothing; every
    // cancel is abandoned (wake from sleep keeps the audio, not the text; the stuck-finalize
    // watchdog claims its outcome before cancelling).
    const report = cancelLive.search(/\breportSessionOutcome\(endOutcome\(\), true\)/);
    expect(report, "cancelLive must report a user cancel as abandoned").toBeGreaterThanOrEqual(0);
    expect(report).toBeLessThan(cancelLive.indexOf("sessionTyped = false"));
    expect(report).toBeLessThan(cancelLive.indexOf("sessionClipboard = false"));
    // deferSessionOutcome (behind reportSessionOutcome) feeds the flags into the abandoned branch.
    expect(mask(topLevelFunctions(streamingSrc).reportSessionOutcome)).toContain("deferSessionOutcome()?.(delivery, abandoned)");
    expect(mask(topLevelFunctions(streamingSrc).deferSessionOutcome)).toContain("landed: sessionTyped || sessionClipboard");
  });

  it("a chord-family restart of a hold session no utterance reached books no stub outcome", () => {
    // The server holds no job for it; record_outcome would INSERT a stub "Nothing" session (and
    // an "aborted" translation) for every restart between differing Profiles.
    const fns = topLevelFunctions(streamingSrc);
    expect(mask(fns.restartLiveAs)).toContain("cancelLive({ keepShortcuts: true, restart: true })");
    expect(mask(fns.startLive)).toContain("cancelLive({ keepShortcuts: true, restart: true }).then(restart)");
    // `mask` blanks the "none" literal, so pin it on the unmasked body.
    expect(fns.cancelLive).toContain('if (opts?.restart && !sessionUtteranceSeen && endOutcome() === "none") deferSessionOutcome();');
    const cancelLive = mask(fns.cancelLive);
    const gate = cancelLive.search(/if \(opts\?\.restart && !sessionUtteranceSeen && endOutcome\(\) ===\s+\) deferSessionOutcome\(\);\s+else reportSessionOutcome\(endOutcome\(\), true\);/);
    expect(gate, "cancelLive skips posting only for an unheard restart, and still claims the slot").toBeGreaterThanOrEqual(0);
    // Read before cancelLive resets it; every start and cancel resets it.
    expect(gate).toBeLessThan(cancelLive.indexOf("sessionUtteranceSeen = false"));
    expect(fns.startLiveInner).toContain("sessionUtteranceSeen = false;");
    // Any frame of an utterance the server announced to this session means it holds a job.
    for (const ev of ['"stream://partial"', '"stream://final"', '"stream://utterance"']) {
      expect(mask(bodyAfter(streamingSrc, ev)), ev).toMatch(/sessionUtteranceSeen = true;/);
    }
  });

  it("a translating session with no text books not_asked, not kept_original", () => {
    // A silent tap, an empty stop or a cancel before any final attempted no translate.
    const body = mask(topLevelFunctions(streamingSrc).deferSessionOutcome);
    const asked = body.split("\n").find((l) => /\basked:/.test(l));
    expect(asked, "deferSessionOutcome must snapshot asked").toBeDefined();
    expect(asked).toContain("sessionTranslation != null");
    expect(asked).toContain("(bankedDoc + committedDoc).trim()");
  });
});

describe("a translate a cancel abandoned stays out of the next session", () => {
  // cancelLive only asks the SERVER to stop the translate; our end of the race keeps waiting
  // for the answer, the live ceiling or the cold stall (20–45 s). A next session started in
  // that window must not be touched when the old promise finally resolves — none of this is
  // reachable without Tauri, so pin the session-token checks around the translate awaits.
  // Up to the column-0 close: both signatures carry an `opts?: { … }` type literal, which
  // topLevelFunctions would take for the body.
  // CRLF-normalized: a Windows checkout has no "\n}\n".
  const src = streamingSrc.replace(/\r\n/g, "\n");
  const whole = (name: string) => {
    const at = src.indexOf(`async function ${name}(`);
    expect(at, `${name} not found`).toBeGreaterThanOrEqual(0);
    return src.slice(at, src.indexOf("\n}\n", at) + 2);
  };
  const fns = { translatePhrase: whole("translatePhrase"), maybeTranslate: whole("maybeTranslate") };

  it("translatePhrase restores the displaced status only for its own session", () => {
    // Without the token, session A's late finally saw session B's "translating" and stamped
    // A's "listening" over B's tail — B never settled (it needs "injecting" to).
    const fin = mask(bodyAfter(fns.translatePhrase, "} finally"));
    expect(fin).toMatch(/if \(insertCfg === cfg && useApp\.getState\(\)\.status ===\s+&& isActiveDictation\(before\)\)/);
  });

  it("maybeTranslate names the session's job before the first await", () => {
    // Read after the captureIds wait, `sessionMeta` may already be the NEXT session's.
    const body = mask(fns.maybeTranslate);
    const firstAwait = body.indexOf("await ");
    const decl = body.indexOf("const clientJob = sessionMeta?.clientJob ?? null;");
    expect(decl, "clientJob is read synchronously").toBeGreaterThanOrEqual(0);
    expect(decl).toBeLessThan(firstAwait);
    expect(body.slice(firstAwait)).not.toContain("sessionMeta");
    expect(body).toMatch(/\bclientJob,/);
  });

  it("maybeTranslate sends no request for a session the captureIds wait outlived", () => {
    const body = mask(fns.maybeTranslate);
    const take = body.indexOf("await captureIds.take(");
    const send = body.indexOf("await runDictationTranslate(");
    expect(take, "the capture wait moved — update streaming.cancelAudit.test.ts").toBeGreaterThanOrEqual(0);
    expect(send).toBeGreaterThan(take);
    expect(body.slice(take, send)).toContain("if (insertCfg !== cfg) return {");
  });
});

describe("a chord-family re-press during the start reads the activation the session will have", () => {
  // dictation.ts stops a session liveActivation() calls hands-free and upgrades one it calls
  // hold: frozen at the launch activation, a re-press over a queued or applied upgrade was taken
  // for another upgrade instead of the stop that turns hands-free off.
  const base = { starting: true, startingActivation: "hold" as const, upgradeQueued: false, capturing: false, cfgActivation: null };
  it("an upgrade already applied by startLiveInner → hands-free", () => {
    expect(liveActivationOf({ ...base, capturing: true, cfgActivation: "handsfree" })).toBe("handsfree");
  });
  it("an upgrade still queued → hands-free", () => {
    expect(liveActivationOf({ ...base, upgradeQueued: true })).toBe("handsfree");
    expect(liveActivationOf({ ...base, upgradeQueued: true, capturing: true, cfgActivation: "hold" })).toBe("handsfree");
  });
  it("nothing queued → the launch activation, even over a finalizing session's stale config", () => {
    expect(liveActivationOf(base)).toBe("hold");
    expect(liveActivationOf({ ...base, cfgActivation: "handsfree" })).toBe("hold");
    expect(liveActivationOf({ ...base, capturing: true, cfgActivation: "hold" })).toBe("hold");
  });
  it("past the start it is the session's own; null with none", () => {
    expect(liveActivationOf({ ...base, starting: false, capturing: true, cfgActivation: "handsfree" })).toBe("handsfree");
    expect(liveActivationOf({ ...base, starting: false, startingActivation: null })).toBe(null);
  });
});
