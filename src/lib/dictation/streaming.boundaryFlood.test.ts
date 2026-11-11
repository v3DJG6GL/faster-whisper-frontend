// The hard break's two uncounted inject-chain links under a server that sends `stream://boundary`
// at any rate. Runs the REAL boundary handler, enqueueInject and oweDroppedInsert (sliced from the
// source, types stripped) against stubbed injection calls, so the test sees exactly what a session
// would type, press and restore.
import { describe, expect, it } from "vitest";
import { transformWithOxc } from "vite";
import streamingSrc from "./streaming.ts?raw";
import { settleOwedUtterances } from "./streaming";
import { joinCarry, untypedRemainder } from "./typedBaseline";

/** A top-level `function name(...) {...}` of streaming.ts (they all close on a `}` at column 0). */
function topLevel(name: string): string {
  const at = streamingSrc.indexOf(`\nfunction ${name}(`);
  expect(at, `${name} moved — update streaming.boundaryFlood.test.ts`).toBeGreaterThanOrEqual(0);
  return streamingSrc.slice(at, streamingSrc.indexOf("\n}\n", at) + 2);
}

/** A top-level `const NAME = ...;` of streaming.ts. */
function constDecl(name: string): string {
  const m = streamingSrc.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  expect(m, `${name} moved — update streaming.boundaryFlood.test.ts`).not.toBeNull();
  return m![0];
}

/** The boundary handler, `(e) => {...}`. */
function boundaryHandler(): string {
  const open = '"stream://boundary", ';
  const at = streamingSrc.indexOf(open);
  const next = streamingSrc.indexOf('await reg<string>("stream://status"', at);
  expect(at >= 0 && next > at, "the boundary handler moved — update streaming.boundaryFlood.test.ts").toBe(true);
  return streamingSrc.slice(at + open.length, streamingSrc.lastIndexOf("});", next) + 1);
}

/** Counts `.then` calls on the chain: every link appended (enqueueInject's catch/finally too). */
class CountingPromise<T> extends Promise<T> {
  static thens = 0;
  override then<A = T, B = never>(
    ok?: ((v: T) => A | PromiseLike<A>) | null,
    err?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    CountingPromise.thens++;
    return super.then(ok, err);
  }
}

const PRELUDE = `
// enqueueInject warns per dropped task; a flood test drops tens of thousands.
const console = { warn() {}, error: globalThis.console.error };
const MAX_BANKED_DOC = 8 * 1024 * 1024;
const MAX_INJECT_DEPTH = 64;
const log = [];
let committedDoc = "", bankedDoc = "", clipBaseline = "", clipClosed = null, seenDoc = "";
let utteranceDocEnd = 0, lastUtterance = null;
let insertCfg = { live, activation: "handsfree" };
let injectChain = Start.resolve();
let injectDepth = { n: 0 };
let boundaryTail = null;
let uncountedCost = { n: 0 };
${constDecl("UNCOUNTED_LINK_COST")}
${constDecl("MAX_UNCOUNTED_COST")}
let clipBooked = null, clipLanded = false, clipLastCopy = null;
let injectedText = "", carryText = "", carrySep = "", owedUtterances = [];
let phraseDirty = false, lastPhraseDiverted = false, lastTypedApp = undefined;
const gapOwedApps = new Set();
let beganInjection = false, clipDirty = false;
let gate = null;
const inSession = () => true;
const flushClipByLang = () => { stats.resets++; };
const noteDivergence = () => {};
const logLine = () => {};
const endUtterance = () => {};
const resetPartialPreview = () => {};
const setDictation = () => {};
const clearPhraseEndTimer = () => {};
const holdCoerced = () => false;
const targetArgs = () => ({});
const target = { method: "paste", restoreClipboard: true, isSelf: false, appId: "app", autoEnter: false };
const resolveTarget = async () => { if (gate) await gate; return target; };
const beginInjection = async () => { log.push("snapshot"); };
const giveClipboardBack = async () => { log.push("restore"); };
const injectText = async (a) => { log.push("type " + JSON.stringify(a.text)); return { landed: true, diverted: false }; };
const pressReturn = async () => { log.push("Return"); return true; };
function oweRecord(id, from) { if (!owedUtterances.some((o) => o.id === id)) owedUtterances.push({ id, from }); }
`;

const ENV_API = `
let ids = 0;
let settled = null;
return {
  boundary(sep) { if (noCoalesce) boundaryTail = null; handler({ payload: sep }); },
  /** A final whose phrase task types the document (or skips it, owing its record). */
  final(text, typed = true) {
    const from = committedDoc.length;
    committedDoc += text;
    phraseDirty = true;
    const doc = committedDoc.replace(/^\\s+/, "");
    const id = "u" + ++ids;
    const cfg = insertCfg;
    const queued = enqueueInject(async () => {
      await resolveTarget(cfg);
      if (!typed) { oweRecord(id, from); return; }
      const out = untypedRemainder(injectedText, doc);
      const body = carryText ? joinCarry(carryText, carrySep, out) : out;
      carryText = ""; carrySep = "";
      log.push("type " + JSON.stringify(body));
      injectedText = doc;
      beganInjection = true; clipDirty = true;
      lastTypedApp = "app"; gapOwedApps.add("app");
      owedUtterances = settleOwedUtterances(owedUtterances, { kind: "body" }).owed;
    });
    if (!queued && !typed) oweDroppedInsert(cfg, id, from);
  },
  /** A server final carrying a document but no utterance (nothing queued for it). */
  bareDoc(text) { committedDoc = text; },
  /** A predecessor link that rejected (no counted task's catch after it yet). */
  rejectHead() { injectChain = Start.reject(new Error("head")); },
  async settle() { await injectChain.then(() => "ok", (e) => e.message).then((r) => { settled = r; }); return settled; },
  hold() { let open; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; },
  async drain() { for (let c = injectChain; ; c = injectChain) { await c; await null; if (c === injectChain) return; } },
  state: () => ({ log: [...log], injectedText, carryText, carrySep, owed: owedUtterances.map((o) => ({ ...o })), clipDirty, clipBooked, clipLanded, clipLastCopy, bankedDoc, phraseDirty }),
  cost: () => uncountedCost.n,
  budget: MAX_UNCOUNTED_COST,
  linkCost: UNCOUNTED_LINK_COST,
};
`;

type Env = {
  boundary(sep: string): void;
  final(text: string, typed?: boolean): void;
  bareDoc(text: string): void;
  rejectHead(): void;
  settle(): Promise<string>;
  hold(): () => void;
  drain(): Promise<void>;
  state(): Record<string, unknown> & { log: string[] };
  cost(): number;
  budget: number;
  linkCost: number;
};

const stats = { resets: 0 };
const compiled = (async () => {
  const src = `${PRELUDE}
${topLevel("enqueueInject")}
${topLevel("oweDroppedInsert")}
${topLevel("refundThrough")}
const handler = ${boundaryHandler()};
${ENV_API}`;
  const { code } = await transformWithOxc(`function makeEnv(Start, stats, settleOwedUtterances, untypedRemainder, joinCarry, noCoalesce, live) {${src}}`, "env.ts");
  return new Function(`${code}\nreturn makeEnv;`)() as (
    start: PromiseConstructor,
    s: typeof stats,
    settle: typeof settleOwedUtterances,
    rem: typeof untypedRemainder,
    join: typeof joinCarry,
    noCoalesce: boolean,
    live: boolean,
  ) => Env;
})();

async function env(noCoalesce = false, start: PromiseConstructor = Promise, live = true): Promise<Env> {
  return (await compiled)(start, stats, settleOwedUtterances, untypedRemainder, joinCarry, noCoalesce, live);
}

/** A dictation with every shape a break meets: typed and untyped phrases (a carry), separators
 *  plain/empty/multi-line, breaks back to back with nothing between, a break while a phrase is
 *  still queued. `noCoalesce` replays it with every break appending its links, as before. */
async function session(noCoalesce: boolean): Promise<Record<string, unknown>[]> {
  const e = await env(noCoalesce);
  const snaps: Record<string, unknown>[] = [];
  const step = async () => {
    await e.drain();
    snaps.push(e.state());
  };
  e.final("Hello there.");
  await step();
  e.boundary(" ");
  e.boundary(" ");
  e.boundary("");
  await step();
  e.final(" Second phrase.");
  e.boundary("\n");
  e.boundary("\n");
  await step();
  e.boundary("");
  e.boundary("");
  await step();
  e.final("Never typed.", false);
  e.boundary(" ");
  e.boundary(" ");
  e.boundary(".\n");
  await step();
  e.final(" Now typed.");
  await step();
  e.boundary("");
  e.final(" After.");
  e.boundary("");
  e.boundary("");
  await step();
  // Breaks queued behind a phrase still waiting on its target.
  const open = e.hold();
  e.final(" Held.");
  e.boundary(" ");
  e.boundary(" ");
  e.boundary("");
  open();
  await step();
  return snaps;
}

describe("the hard break under a boundary flood", () => {
  it("a real session types, presses and restores exactly as with every break's links appended", async () => {
    const coalesced = await session(false);
    const appended = await session(true);
    expect(coalesced).toEqual(appended);
    // The comparison saw real output, not two empty runs.
    const last = coalesced[coalesced.length - 1].log as string[];
    expect(last).toContain('type "Hello there."');
    expect(last).toContain("Return");
    expect(last).toContain("restore");
    expect(last.some((l) => l.includes("Never typed."))).toBe(true);
  });

  it("empty breaks behind a stalled queue keep a bounded number of links", async () => {
    const e = await env(false, CountingPromise as unknown as PromiseConstructor);
    const open = e.hold();
    e.final("Stuck.");
    const before = CountingPromise.thens;
    stats.resets = 0;
    for (let i = 0; i < 5000; i++) e.boundary(i % 2 ? " " : "");
    // The separator task is counted (MAX_INJECT_DEPTH); between two counted tasks at most one
    // boundary pair: 64 × (then + catch + finally) + 65 × 2, far from 2 × 5000.
    expect(CountingPromise.thens - before).toBeLessThanOrEqual(64 * 3 + 65 * 2);
    open();
    await e.drain();
    expect(stats.resets).toBeLessThanOrEqual(65);
    expect(e.state().log[0]).toBe('type "Stuck."');
  });

  it("big documents between breaks are held up to the budget, and the links stay bounded", async () => {
    const e = await env(false, CountingPromise as unknown as PromiseConstructor);
    const open = e.hold();
    e.final("Stuck.");
    const big = "x".repeat(4 * 1024 * 1024);
    const before = CountingPromise.thens;
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      e.bareDoc(big + i);
      e.boundary("");
      peak = Math.max(peak, e.cost());
    }
    expect(peak).toBeLessThanOrEqual(e.budget);
    // Two documents fit the budget (the first break also queues its counted separator task); every
    // later break holds none and repeats the tail pair.
    expect(CountingPromise.thens - before).toBeLessThanOrEqual(2 * 2 + 3);
    open();
    await e.drain();
    expect(e.cost()).toBe(0);
  });

  it("one-char finals dropped at the cap, each with a long-separator break, stay within the budget", async () => {
    // Every break holds a document ("x"), so none repeats the tail; each dropped final owes its
    // record from one more uncounted link. Charged at their real cost, the links stop at the budget.
    // A "stop"-timing session: the links are the same, and the drain skips carrying thousands of
    // one-char remainders (the carry's own quadratic joins, not what this test is about).
    const e = await env(false, CountingPromise as unknown as PromiseConstructor, false);
    const open = e.hold();
    e.final("Stuck.");
    for (let i = 0; i < 63; i++) e.final("q", false);
    const sep = " ".repeat(520);
    const before = CountingPromise.thens;
    const rounds = 40_000;
    let peak = 0;
    for (let i = 0; i < rounds; i++) {
      e.final("x", false);
      e.boundary(sep);
      peak = Math.max(peak, e.cost());
    }
    // Each link costs at least linkCost. Past the budget a break holds no document and owes no
    // record, so only the pair a counted task (or the last owe link) cut off from the tail adds
    // more: one per counted task at most, the queue's 64 and one.
    expect(peak).toBeLessThanOrEqual(e.budget + 65 * (2 * e.linkCost + sep.length));
    const links = CountingPromise.thens - before;
    expect(links).toBeLessThanOrEqual(e.budget / e.linkCost + 65 * 2);
    expect(links).toBeLessThan(rounds);
    open();
    await e.drain();
    expect(e.cost()).toBe(0);
    expect(e.state().log[0]).toBe('type "Stuck."');
  });

  it("links a rejected predecessor skips refund their cost and pass the rejection on", async () => {
    const e = await env(false, Promise, false);
    e.rejectHead();
    e.bareDoc("some text");
    e.boundary(" ");
    expect(e.cost()).toBeGreaterThan(0);
    // The chain settles as without the arm: still rejected, with the head's reason.
    expect(await e.settle()).toBe("head");
    expect(e.cost()).toBe(0);
  });

  it("finals dropped at the cap before a break still owe their records into the carry", async () => {
    const e = await env(false);
    const open = e.hold();
    e.final("Stuck.");
    for (let i = 0; i < 70; i++) e.final(` p${i}.`, false);
    e.boundary("");
    e.boundary("");
    open();
    await e.drain();
    // Only "Stuck." was typed: the break carries the rest, and every record goes with it — the
    // ones dropped at the cap (oweDroppedInsert) too. The second, empty break repeated the first.
    const s = e.state();
    expect(s.carryText).toContain("p69.");
    expect((s.owed as { id: string }[]).length).toBe(70);
  });
});

describe("the pause's queued window close behind a stuck chain head", () => {
  // bumpPhraseEnd's close link is uncounted and comes once per 1.2 s pause. It used to capture the
  // whole closed window, whose `baseline` is the previous final's entire document, so every link
  // waiting behind a stuck head parked a distinct multi-MB copy. It now holds the window's `rec`.
  const PAUSE_ENV = `
let insertCfg = { live: true, activation: "handsfree" };
let phraseEndTimer = null, phraseDeferSince = null, phraseDirty = false;
const PHRASE_DEFER_MAX_MS = 30000, PHRASE_END_QUIET_MS = 1200;
const isCapturing = () => false, pendingIsLive = () => false, pending = null;
const enqueueAutoEnter = () => {};
let committedDoc = "", clipBaseline = "", clipOrdinalSeen = true, clipClosed = null;
let clipDirty = false, beganInjection = false, clipBooked = null, clipByLang = undefined, clipLanded = false;
let boundaryTail = null;
let open;
let injectChain = new Promise((r) => { open = r; });
const giveClipboardBack = async () => {};
const flushClipByLang = () => { clipByLang = undefined; };
let fire = null;
const setTimeout = (cb) => { fire = cb; return 1; };
const clearTimeout = () => {};
${topLevel("bumpPhraseEnd")}
return {
  pause(doc) { committedDoc = doc; bumpPhraseEnd(); const cb = fire; fire = null; cb(); return clipClosed; },
  land(booked) { clipLanded = true; clipBooked = booked; },
  release() { open(); },
  async drain() { for (let c = injectChain; ; c = injectChain) { await c; await null; if (c === injectChain) return; } },
  closed: () => clipClosed,
};`;
  type PauseEnv = {
    pause(doc: string): object | null;
    land(booked: object): void;
    release(): void;
    drain(): Promise<void>;
    closed(): { baseline: string; rec: { booked: unknown; landed: boolean } } | null;
  };
  const pauseEnv = (async () => {
    const { code } = await transformWithOxc(`function makePauseEnv() {${PAUSE_ENV}}`, "pause.ts");
    return new Function(`${code}\nreturn makePauseEnv;`)() as () => PauseEnv;
  })();

  it("a waiting close link keeps neither the closed window nor its document alive", async () => {
    const { setFlagsFromString } = await import("node:v8");
    const { runInNewContext } = await import("node:vm");
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    const e = (await pauseEnv)();
    // The project's lib predates WeakRef's typings; the runtime has it.
    type Weak = { deref(): object | undefined };
    const WeakRefCtor = (globalThis as unknown as { WeakRef: new (target: object) => Weak }).WeakRef;
    const windows: Weak[] = [];
    for (let i = 0; i < 20; i++) {
      // Each pause closes the window opened by the one before: a distinct 1 MiB document each.
      const w = e.pause(`${"x".repeat(1024 * 1024)} ${i}`);
      if (i > 0) windows.push(new WeakRefCtor(w!));
    }
    // A WeakRef target lives at least until the current job ends.
    await new Promise((r) => globalThis.setTimeout(r, 0));
    gc();
    // All but the latest (still clipClosed) are unreachable although 20 close links still wait.
    const alive = windows.slice(0, -1).filter((w) => w.deref() !== undefined).length;
    expect(alive).toBe(0);
    // The links still record into the window a release final reopens: once the head moves, a
    // copy lands and the next pause closes that window with it.
    e.release();
    await e.drain();
    const booked = { text: "", ctxLen: 0 };
    e.land(booked);
    e.pause("next");
    await e.drain();
    const last = e.closed()!;
    expect(last.baseline.endsWith(" 19")).toBe(true);
    expect(last.rec.landed).toBe(true);
    expect(last.rec.booked).toBe(booked);
  });
});
