// The two store fields a speech server can flip at its own frame rate — `partial` (through
// `stream://final`) and `serverWork` (through `stream://utterance` and the `loading` status) —
// under a virtual clock. Runs
// the REAL pacers and the REAL partial handler (sliced from the source, types stripped) against a
// stub store, so the test sees exactly what a session would paint, and when.
import { describe, expect, it } from "vitest";
import { transformWithOxc } from "vite";
import streamingRaw from "./streaming.ts?raw";
import dictationRaw from "./dictation.ts?raw";
import { isActiveDictation } from "./dictationVisual";
import * as utterancePending from "./utterancePending";

// CRLF-normalized: a Windows checkout has no "\n}\n" and no bare-"\n" regex match.
const streamingSrc = streamingRaw.replace(/\r\n/g, "\n");
const dictationSrc = dictationRaw.replace(/\r\n/g, "\n");

/** A top-level `function name(...) {...}` of streaming.ts (they all close on a `}` at column 0). */
function topLevel(name: string): string {
  const at = streamingSrc.indexOf(`\nfunction ${name}(`);
  expect(at, `${name} moved — update streaming.previewPacer.test.ts`).toBeGreaterThanOrEqual(0);
  return streamingSrc.slice(at, streamingSrc.indexOf("\n}\n", at) + 2);
}

/** A top-level `const NAME = ...;` of streaming.ts. */
function constDecl(name: string): string {
  const m = streamingSrc.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  expect(m, `${name} moved — update streaming.previewPacer.test.ts`).not.toBeNull();
  return m![0];
}

/** The partial handler, `(e) => {...}`. */
function partialHandler(): string {
  const open = '"stream://partial", ';
  const at = streamingSrc.indexOf(open);
  const next = streamingSrc.indexOf("type FinalFrame", at);
  expect(at >= 0 && next > at, "the partial handler moved — update streaming.previewPacer.test.ts").toBe(true);
  return streamingSrc.slice(at + open.length, streamingSrc.lastIndexOf("});", next) + 1);
}

type Clock = {
  now: number;
  set(cb: () => void, ms?: number): number;
  clear(id?: number): void;
  /** Run every timer due within `ms`, each at its own time, then stand at the end of it. */
  advance(ms: number): void;
  armed(): number;
};

function makeClock(): Clock {
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const clock: Clock = {
    now: 1000,
    set(cb, ms = 0) {
      timers.set(++seq, { at: clock.now + Math.max(0, ms), cb });
      return seq;
    },
    clear(id) {
      if (id !== undefined) timers.delete(id);
    },
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        let due: number | undefined;
        for (const [id, t] of timers) {
          if (t.at <= end && (due === undefined || t.at < timers.get(due)!.at)) due = id;
        }
        if (due === undefined) break;
        const t = timers.get(due)!;
        timers.delete(due);
        clock.now = Math.max(clock.now, t.at);
        t.cb();
      }
      clock.now = end;
    },
    armed: () => timers.size,
  };
  return clock;
}

const ENV = `
const performance = { now: () => clock.now };
const setTimeout = clock.set, clearTimeout = clock.clear;
const store = { status: "listening", partial: "", serverWork: null };
const painted = [];
const published = [];
const setDictation = (patch) => {
  if ("partial" in patch) painted.push(patch.partial);
  if ("serverWork" in patch) published.push(patch.serverWork);
  Object.assign(store, patch);
};
const useApp = { getState: () => ({ ...store, setDictation }) };
const inSession = () => isActiveDictation(store.status);
const isCapturing = () => store.status === "listening";
let sessionUtteranceSeen = false;
const insertCfg = null;
const bumpPhraseEnd = () => {};

let committedDoc = "";
${constDecl("PARTIAL_MIN_MS")}
let lastPartialAt = 0, partialTimer, latestPartial = null;
let lastFinalAt = 0, finalTimer, finalOwed = false;
${topLevel("resetPartialPreview")}
${topLevel("paintFinal")}
${topLevel("showFinalPreview")}
${topLevel("flushPartial")}
const onPartial = ${partialHandler()};

const { display: pendingDisplay, holdRemainingMs, msUntilStale, onFrame: onUtteranceFrame, onTerminal: onUtteranceTerminal, reset: resetPending } = up;
const pending = up.newUtterancePending();
let workTimer;
${constDecl("WORK_MIN_MS")}
let lastWorkPublishAt = 0;
${topLevel("clearWorkTimer")}
${topLevel("publishServerWork")}
${topLevel("syncServerWork")}
${topLevel("publishLoading")}
${topLevel("endUtterance")}
${topLevel("resetServerWork")}

return {
  partial(text) { onPartial({ payload: { committed: "", pending: text } }); },
  // The final handler's preview half, in the handler's order (pinned against the source below).
  final(doc) { if (!inSession()) return; committedDoc = doc; showFinalPreview(); },
  // The other writers of \`partial\`, each as the source has it: reset, then its own write.
  boundary() { committedDoc = ""; resetPartialPreview(); setDictation({ partial: "" }); },
  cancel() { committedDoc = ""; resetPartialPreview(); setDictation({ status: "idle", partial: "" }); },
  flashError() { resetPartialPreview(); setDictation({ status: "error", partial: "" }); },
  start() { committedDoc = ""; resetPartialPreview(); setDictation({ status: "listening", partial: "" }); },
  // settleIdle: the status moves, \`partial\` and the session's documents are deliberately kept.
  settle() { store.status = "idle"; },
  utterance(state, ordinal) { onUtteranceFrame(pending, state, ordinal, performance.now()); syncServerWork(); },
  endUtterance,
  // The status handler's \`loading\` (mic-open half) and \`ready\` clears, as the source has them (pinned below).
  loading() { if (useApp.getState().status === "listening" && isCapturing()) publishLoading(); },
  ready() { if (useApp.getState().serverWork === "loading") setDictation({ serverWork: null }); },
  // Every teardown: the module half, then the caller's own patch.
  teardown() { resetServerWork(); setDictation({ serverWork: null }); },
  store, painted, published,
};`;

type Env = {
  partial(text: string): void;
  final(doc: string): void;
  boundary(): void;
  cancel(): void;
  flashError(): void;
  start(): void;
  settle(): void;
  utterance(state: "open" | "decoding", ordinal: number | null): void;
  endUtterance(): void;
  loading(): void;
  ready(): void;
  teardown(): void;
  store: { status: string; partial: string; serverWork: string | null };
  painted: string[];
  published: (string | null)[];
};

const compiled = (async () => {
  const { code } = await transformWithOxc(`function makeEnv(clock, isActiveDictation, up) {${ENV}}`, "env.ts");
  return new Function(`${code}\nreturn makeEnv;`)() as (
    clock: Clock,
    active: typeof isActiveDictation,
    up: typeof utterancePending,
  ) => Env;
})();

async function env(): Promise<{ e: Env; clock: Clock }> {
  const clock = makeClock();
  return { e: (await compiled)(clock, isActiveDictation, utterancePending), clock };
}

/** One 33 ms floor's worth of publishes over `ms` of flood, plus the leading one. */
const paced = (ms: number) => Math.floor(ms / 33) + 1;

describe("the final handler's paced preview", () => {
  it("the source's handler and the outside writer are what this file simulates", () => {
    // `final`: fold the document in, then the paced paint — nothing else writes `partial` there.
    expect(streamingSrc).toMatch(
      /committedDoc = e\.payload\.committed \+ e\.payload\.tail;\n(?:\s*\/\/[^\n]*\n)*\s*showFinalPreview\(\);/,
    );
    const from = streamingSrc.indexOf('reg<FinalFrame>("stream://final"');
    const handler = streamingSrc.slice(from, streamingSrc.indexOf('reg<RecordingFrame>("stream://recording"', from));
    expect(handler).not.toMatch(/setDictation\(\{[^}]*\bpartial\b/);
    // The one writer of `partial` outside streaming.ts drops the pending ticks before it writes.
    expect(dictationSrc).toMatch(/dropPreviewTicks\(\);\n\s*s\.setDictation\(\{[^}]*partial: ""/);
    expect(dictationSrc.match(/\bpartial:/g), "a new writer of `partial` there needs dropPreviewTicks() too").toHaveLength(1);
  });

  it("a final right after a partial paints on its own frame, and no partial tick undoes it", async () => {
    const { e, clock } = await env();
    e.partial("Hello wor");
    expect(e.store.partial).toBe("Hello wor");
    clock.advance(10);
    e.partial("Hello world"); // inside the partial floor: a trailing tick is armed
    clock.advance(2);
    e.final("Hello world.");
    // Not on the partial pacer's clock: there it would have waited for the tick.
    expect(e.store.partial).toBe("Hello world.");
    clock.advance(200);
    expect(e.store.partial).toBe("Hello world.");
    expect(e.painted).toEqual(["Hello wor", "Hello world."]);
    expect(clock.armed()).toBe(0);
  });

  it("finals a real session sends paint synchronously, every one", async () => {
    const { e, clock } = await env();
    for (const [gap, doc] of [[1500, "One."], [40, "One. Two."], [900, "One. Two. Three."]] as const) {
      clock.advance(gap);
      e.final(doc);
      expect(e.store.partial).toBe(doc);
    }
    expect(clock.armed()).toBe(0);
  });

  it("the closing final right behind an utterance final is painted after the session settled", async () => {
    const { e, clock } = await env();
    e.final("One.");
    clock.advance(4);
    e.final("One. Two."); // the `last` final, inside the floor
    expect(e.store.partial).toBe("One.");
    clock.advance(1);
    e.settle();
    clock.advance(40);
    expect(e.store.status).toBe("idle");
    expect(e.store.partial).toBe("One. Two.");
  });

  it("the trailing tick paints the newest document", async () => {
    const { e, clock } = await env();
    e.final("A");
    clock.advance(5);
    e.final("A B");
    clock.advance(5);
    e.final("A B C");
    clock.advance(40);
    expect(e.painted).toEqual(["A", "A B C"]);
  });

  it.each(["boundary", "cancel", "flashError", "start"] as const)(
    "a %s during a pending tick leaves nothing to paint after it",
    async (writer) => {
      const { e, clock } = await env();
      e.final("Old document.");
      clock.advance(5);
      e.final("Old document. More.");
      clock.advance(5);
      e[writer]();
      expect(clock.armed()).toBe(0);
      clock.advance(200);
      expect(e.store.partial).toBe("");
      expect(e.painted[e.painted.length - 1]).toBe("");
    },
  );

  it("a partial painted while a final's tick is pending is not overwritten by that tick", async () => {
    const { e, clock } = await env();
    e.final("A.");
    clock.advance(5);
    e.final("A. B."); // deferred
    clock.advance(5);
    e.partial("c"); // the partial pacer's leading edge: painted now, final's document included
    expect(e.store.partial).toBe("A. B. c");
    expect(clock.armed()).toBe(0);
    clock.advance(100);
    expect(e.painted).toEqual(["A.", "A. B. c"]);
  });

  it("a partial behind a deferred final keeps the newer preview", async () => {
    const { e, clock } = await env();
    e.final("A.");
    clock.advance(1);
    e.partial("b"); // leading edge of the partial pacer
    clock.advance(4);
    e.final("A. B."); // deferred
    clock.advance(5);
    e.partial("c"); // inside the partial floor too: its own tick carries the final's document
    clock.advance(100);
    expect(e.painted).toEqual(["A.", "A. b", "A. B. c"]);
    expect(clock.armed()).toBe(0);
  });

  it("…and when the session settles before that partial's tick, the final's document still lands", async () => {
    const { e, clock } = await env();
    e.final("A.");
    clock.advance(1);
    e.partial("b");
    clock.advance(4);
    e.final("A. B.");
    clock.advance(5);
    e.partial("c");
    clock.advance(1);
    e.settle();
    clock.advance(100);
    // The preview "c" is dropped at idle as before; the committed text is not.
    expect(e.store.partial).toBe("A. B.");
  });

  it("…but not after a cancel", async () => {
    const { e, clock } = await env();
    e.final("A.");
    clock.advance(1);
    e.partial("b");
    clock.advance(4);
    e.final("A. B.");
    clock.advance(5);
    e.partial("c");
    clock.advance(1);
    e.cancel();
    clock.advance(100);
    expect(e.store.partial).toBe("");
    expect(clock.armed()).toBe(0);
  });

  it("a flood of alternating finals writes the store at the floor's rate and ends on the last one", async () => {
    const { e, clock } = await env();
    const frames = 5000;
    for (let i = 0; i < frames; i++) {
      e.final(i % 2 ? "document A" : "document B");
      clock.advance(0.1);
    }
    expect(e.painted.length).toBeLessThanOrEqual(paced(500));
    expect(e.painted.length).toBeGreaterThan(2);
    e.final("the last word");
    clock.advance(100);
    expect(e.store.partial).toBe("the last word");
    expect(e.painted.length).toBeLessThanOrEqual(paced(500) + 1);
  });

  it("finals and partials alternating stay within the two floors", async () => {
    const { e, clock } = await env();
    for (let i = 0; i < 5000; i++) {
      if (i % 2) e.partial(`p${i}`);
      else e.final(`f${i}`);
      clock.advance(0.1);
    }
    clock.advance(100);
    expect(e.painted.length).toBeLessThanOrEqual(2 * paced(500) + 1);
    // Whatever was painted last carries the last final's document.
    expect(e.store.partial.startsWith("f4998")).toBe(true);
  });
});

describe("syncServerWork's paced publish", () => {
  it("a real utterance's edges publish on their own frame", async () => {
    const { e, clock } = await env();
    e.utterance("open", 1);
    expect(e.store.serverWork).toBe("open");
    clock.advance(1200); // the server's commit silence
    e.utterance("decoding", 1);
    expect(e.store.serverWork).toBe("decoding");
    clock.advance(60);
    e.endUtterance();
    expect(e.store.serverWork).toBeNull();
    clock.advance(300);
    e.utterance("open", 2);
    expect(e.store.serverWork).toBe("open");
    expect(e.published).toEqual(["open", "decoding", null, "open"]);
  });

  it.each([
    ["one utterance", () => 1],
    ["rising ordinals", (i: number) => i],
  ])("a flood of open/decoding flips (%s) publishes at the floor's rate and ends on the last state", async (_n, ordinal) => {
    const { e, clock } = await env();
    for (let i = 0; i < 5000; i++) {
      e.utterance(i % 2 ? "decoding" : "open", ordinal(i));
      clock.advance(0.1);
    }
    expect(e.published.length).toBeLessThanOrEqual(paced(500));
    expect(e.published.length).toBeGreaterThan(2);
    clock.advance(100);
    expect(e.store.serverWork).toBe("decoding");
    expect(e.published.length).toBeLessThanOrEqual(paced(500) + 1);
  });

  it("a deferred publish still arms the staleness wake-up", async () => {
    const { e, clock } = await env();
    e.utterance("open", 1);
    clock.advance(1);
    e.utterance("decoding", 1); // inside the floor
    expect(e.store.serverWork).toBe("open");
    clock.advance(40);
    expect(e.store.serverWork).toBe("decoding");
    // DECODING_MAX_MS: a `decoding` whose terminal never comes cannot latch.
    clock.advance(utterancePending.DECODING_MAX_MS + 100);
    expect(e.store.serverWork).toBeNull();
    expect(clock.armed()).toBe(0);
  });

  it("a terminal or a teardown during a pending publish leaves nothing to publish after it", async () => {
    for (const end of ["endUtterance", "teardown"] as const) {
      const { e, clock } = await env();
      e.utterance("open", 1); // published
      clock.advance(1);
      e.utterance("decoding", 1); // inside the floor: waits
      clock.advance(1);
      e[end]();
      const before = e.published.length;
      clock.advance(utterancePending.MIN_SHOW_MS + 100);
      expect(e.store.serverWork).toBeNull();
      // Nothing but the clear itself: the deferred "decoding" never surfaces.
      expect(e.published.slice(before).filter((v) => v !== null)).toEqual([]);
      expect(clock.armed()).toBe(0);
    }
  });
});

describe("the `loading` keepalive's paced publish", () => {
  it("the source's status handler is what this file simulates", () => {
    const from = streamingSrc.indexOf('reg<string>("stream://status"');
    const handler = streamingSrc.slice(from, streamingSrc.indexOf('e.payload === "closed"', from));
    expect(handler).toContain('if (useApp.getState().serverWork === "loading") setDictation({ serverWork: null });');
    expect(handler).toContain('else if (useApp.getState().status === "listening" && isCapturing()) publishLoading();');
    // The paced function is the only way "loading" gets into the store.
    expect(streamingSrc.match(/publishServerWork\("loading"\)/g)).toHaveLength(1);
    expect(streamingSrc).not.toMatch(/serverWork: "loading"/);
  });

  it("a real cold load says so on its first frame, and `ready` clears it at once", async () => {
    const { e, clock } = await env();
    clock.advance(250); // the handshake
    e.loading();
    expect(e.store.serverWork).toBe("loading");
    for (let i = 0; i < 5; i++) {
      clock.advance(3000); // the keepalive
      e.loading();
      expect(e.store.serverWork).toBe("loading");
    }
    clock.advance(1);
    e.ready();
    expect(e.store.serverWork).toBeNull();
    expect(e.published).toEqual(["loading", null]);
    expect(clock.armed()).toBe(0);
  });

  it("a `loading` skipped by the floor is said by the next keepalive", async () => {
    const { e, clock } = await env();
    e.loading();
    clock.advance(1);
    e.ready();
    clock.advance(1);
    e.loading(); // inside the floor: skipped, and no timer says it later
    expect(e.store.serverWork).toBeNull();
    expect(clock.armed()).toBe(0);
    clock.advance(3000);
    expect(e.store.serverWork).toBeNull();
    e.loading(); // the next keepalive
    expect(e.store.serverWork).toBe("loading");
    expect(e.published).toEqual(["loading", null, "loading"]);
  });

  it.each([
    ["`ready`", (e: Env) => e.ready()],
    ["a final / boundary / dropped utterance", (e: Env) => e.endUtterance()],
  ])("a flood of `loading` alternating with %s publishes at the floor's rate", async (_n, clear) => {
    const { e, clock } = await env();
    const ms = 2000;
    for (let i = 0; i < ms; i++) {
      if (i % 2) {
        clear(e);
        // The clear is never paced: a real `ready` cannot be late or lost.
        expect(e.store.serverWork).toBeNull();
      } else e.loading();
      clock.advance(1);
    }
    const shown = e.published.filter((v) => v !== null).length;
    expect(shown).toBeLessThanOrEqual(paced(ms));
    expect(shown).toBeGreaterThan(2);
    // Each clear answers one paced publish.
    expect(e.published.length).toBeLessThanOrEqual(2 * paced(ms));
    expect(clock.armed()).toBe(0);
  });

  it("`loading` alternating with utterance frames shares the one floor", async () => {
    const { e, clock } = await env();
    const ms = 2000;
    for (let i = 0; i < ms; i++) {
      if (i % 2) e.utterance(i % 4 === 1 ? "open" : "decoding", 1);
      else e.loading();
      clock.advance(1);
    }
    expect(e.published.length).toBeLessThanOrEqual(paced(ms));
    expect(e.published.length).toBeGreaterThan(2);
  });

  it("a `loading` after the mic closed publishes nothing", async () => {
    const { e, clock } = await env();
    e.store.status = "transcribing";
    clock.advance(100);
    e.loading();
    expect(e.published).toEqual([]);
  });
});
