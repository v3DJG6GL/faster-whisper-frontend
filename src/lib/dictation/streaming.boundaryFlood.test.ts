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
const MAX_BANKED_DOC = 8 * 1024 * 1024;
const MAX_INJECT_DEPTH = 64;
const log = [];
let committedDoc = "", bankedDoc = "", clipBaseline = "", clipClosed = null, seenDoc = "";
let utteranceDocEnd = 0, lastUtterance = null;
let insertCfg = { live: true, activation: "handsfree" };
let injectChain = Start.resolve();
let injectDepth = { n: 0 };
let boundaryTail = null;
let breakChars = { n: 0 };
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
  hold() { let open; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; },
  async drain() { for (let c = injectChain; ; c = injectChain) { await c; await null; if (c === injectChain) return; } },
  state: () => ({ log: [...log], injectedText, carryText, carrySep, owed: owedUtterances.map((o) => ({ ...o })), clipDirty, clipBooked, clipLanded, clipLastCopy, bankedDoc, phraseDirty }),
  breakChars: () => breakChars.n,
};
`;

type Env = {
  boundary(sep: string): void;
  final(text: string, typed?: boolean): void;
  bareDoc(text: string): void;
  hold(): () => void;
  drain(): Promise<void>;
  state(): Record<string, unknown> & { log: string[] };
  breakChars(): number;
};

const stats = { resets: 0 };
const compiled = (async () => {
  const src = `${PRELUDE}
${topLevel("enqueueInject")}
${topLevel("oweDroppedInsert")}
const handler = ${boundaryHandler()};
${ENV_API}`;
  const { code } = await transformWithOxc(`function makeEnv(Start, stats, settleOwedUtterances, untypedRemainder, joinCarry, noCoalesce) {${src}}`, "env.ts");
  return new Function(`${code}\nreturn makeEnv;`)() as (
    start: PromiseConstructor,
    s: typeof stats,
    settle: typeof settleOwedUtterances,
    rem: typeof untypedRemainder,
    join: typeof joinCarry,
    noCoalesce: boolean,
  ) => Env;
})();

async function env(noCoalesce = false, start: PromiseConstructor = Promise): Promise<Env> {
  return (await compiled)(start, stats, settleOwedUtterances, untypedRemainder, joinCarry, noCoalesce);
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
      peak = Math.max(peak, e.breakChars());
    }
    expect(peak).toBeLessThanOrEqual(8 * 1024 * 1024);
    // Two documents fit the budget; every later break holds none and repeats the tail pair.
    expect(CountingPromise.thens - before).toBeLessThanOrEqual(3 * 2);
    open();
    await e.drain();
    expect(e.breakChars()).toBe(0);
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
