// Model pre-warm leases (POST /v1/models/preload).
//
// A preload is a HINT and nothing else: it has no toast, no store write, no
// logs doorway, and every failure — unreachable, unauthorized, or a 404 from a
// backend too old to know the endpoint — is swallowed. A server that ignores
// this must be indistinguishable, to the user, from one that honours it.
//
// The server's plan lease expires in 180s and it stages ahead on its own, so a
// holder renews on a timer rather than re-POSTing as stages progress. A leaked
// lease would therefore ping a server every two minutes for the life of the
// app — which is why every acquire site must release on EVERY exit path.

import { isTauri, preloadModels, type PreloadFamily } from "./api";
import { useApp } from "./store";
import { effectiveServerKind } from "./serverKind";
import { ownProp } from "./own";
import type { RailStage } from "./transcribeRun";

export type Family = PreloadFamily;

export interface PreloadSpec {
  serverUrl: string;
  backendId: string;
  models: { family: Family; id: string }[];
}

export interface WarmLease {
  /** Drop this holder's reference; the timer stops when the last one goes. */
  release(): void;
}

/** Renew cadence. The server's lease is 180s, so this leaves room for exactly
 *  one lost call before the plan expires — close enough that a dropped request
 *  costs nothing, far enough that we are not chatting every few seconds. */
export const RENEW_MS = 120_000;


type Transport = (args: {
  serverUrl: string;
  backendId?: string | null;
  models: { family: Family; id: string }[];
}) => Promise<boolean>;

// isTauri is checked HERE rather than at each fire site so an injected test
// transport is reached in a plain Node environment, where isTauri is false.
let transport: Transport = (args) => (isTauri ? preloadModels(args) : Promise.resolve(false));

/** Test seam: swap the transport (call with no argument to restore the real one). */
export function setPreloadTransport(fn?: Transport): void {
  transport = fn ?? ((args) => (isTauri ? preloadModels(args) : Promise.resolve(false)));
}

/** Test seam: forget every "last sent" memory, so one test's send can't debounce the next. */
export function resetWarmDebounceForTests(): void {
  lastSent.clear();
}

interface Entry {
  key: string;
  spec: PreloadSpec;
  /** The one-shot "first renew" timeout until it fires, then the steady interval. */
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
  timerIsInterval: boolean;
  refs: number;
  /** Serialized spec of the last hint actually sent, and when — so a re-render
   *  that re-acquires with an identical plan cannot turn into a second POST. */
  sentKey: string;
  sentAt: number;
}

const leases = new Map<string, Entry>();
/** The last hint sent under a key, remembered ACROSS release → re-acquire: React runs an
 *  effect's cleanup before re-running it, so every dep change on a warm-holding effect is
 *  a release (entry deleted) followed by a fresh acquire — which, with the memory on the
 *  entry alone, was an immediate POST of a byte-identical plan on every option click. */
const lastSent = new Map<string, { sentKey: string; sentAt: number }>();

/** Map a run's rail stages onto the model families the server should warm.
 *  Pure — this is the part worth testing. Stages with no known model id are
 *  dropped (the server picks its own default and we have nothing to name), and
 *  `downloading` has no model at all. */
export function preloadPlanFor(opts: {
  stages: readonly RailStage[];
  whisperModel?: string;
  separationModel?: string;
  diarizationModel?: string;
  translationModel?: string;
}): { family: Family; id: string }[] {
  const byStage: Partial<Record<RailStage, { family: Family; id?: string }>> = {
    transcribing: { family: "whisper", id: opts.whisperModel },
    separating: { family: "separation", id: opts.separationModel },
    diarizing: { family: "diarization", id: opts.diarizationModel },
    translating: { family: "translation", id: opts.translationModel },
  };
  const out: { family: Family; id: string }[] = [];
  for (const stage of opts.stages) {
    const hit = byStage[stage];
    const id = hit?.id?.trim();
    if (!hit || !id) continue;
    if (out.some((m) => m.family === hit.family && m.id === id)) continue;
    out.push({ family: hit.family, id });
  }
  return out;
}

/** Whether it is worth sending this plan at all. A PROVEN-standard server has no
 *  such endpoint; a server that explicitly reports translation off would defer a
 *  translation entry anyway. An ABSENT capability is never a denial here, per the
 *  codebase rule — unknown means try. */
function worthSending(spec: PreloadSpec): boolean {
  if (!spec.models.length) return false;
  const st = useApp.getState();
  const backend = st.backends.find((b) => b.id === spec.backendId);
  if (backend && effectiveServerKind(backend, ownProp(st.connections, backend.id)) === "standard") {
    return false;
  }
  if (spec.models.some((m) => m.family === "translation")) {
    const caps = ownProp(st.caps, spec.backendId);
    if (caps?.translation_enabled === false) return false;
  }
  return true;
}

function fire(entry: Entry, force: boolean): void {
  const key = JSON.stringify(entry.spec);
  const now = Date.now();
  // Debounce an identical plan inside the renew window: acquireWarm is called
  // from effects that re-run on unrelated state churn, and without this a burst
  // of re-renders is a burst of POSTs.
  if (!force && key === entry.sentKey && now - entry.sentAt < RENEW_MS) return;
  // Checked BEFORE the send is recorded: a plan we declined because caps aren't
  // known yet must still be sent once they are, rather than being debounced out.
  if (!worthSending(entry.spec)) return;
  entry.sentKey = key;
  entry.sentAt = now;
  lastSent.set(entry.key, { sentKey: key, sentAt: now });
  // Fire-and-forget, and the catch is the whole error policy: nothing about a
  // failed hint is the user's problem, and an unhandled rejection here would
  // surface as a console error on a timer.
  void transport({
    serverUrl: entry.spec.serverUrl,
    backendId: entry.spec.backendId,
    models: entry.spec.models,
  }).catch(() => {});
}

/** Hold a warm lease under `key` (one per logical holder: "dictation", the
 *  transcribe queue, the viewer's translate panel). Refcounted, so a second
 *  acquire of the same key shares the one timer. */
export function acquireWarm(key: string, spec: PreloadSpec): WarmLease {
  let entry = leases.get(key);
  if (entry) {
    entry.refs += 1;
    entry.spec = spec;
    fire(entry, false);
  } else {
    const prev = lastSent.get(key);
    // The first renew tick is due RENEW_MS after the carried send, not after this
    // re-acquire: every React caller releases and re-acquires on any dep change, and a
    // re-acquire at t=119 s was debounced (no POST) while a fresh interval put the next
    // POST at t≈239 s — past the server's 180 s plan lease, with the app believing it
    // held the models warm.
    const e0: Entry = {
      key,
      spec,
      refs: 1,
      sentKey: prev?.sentKey ?? "",
      sentAt: prev?.sentAt ?? 0,
      timerIsInterval: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    entry = e0;
    leases.set(key, entry);
    fire(entry, false);
    // Armed AFTER the acquire's own send: when the carried send was already stale, `fire`
    // just POSTed and stamped `sentAt` — measuring from the OLD stamp put a 0 ms force-POST
    // of the identical plan right behind it.
    const due = Math.max(0, RENEW_MS - (Date.now() - e0.sentAt));
    e0.timer = setTimeout(() => {
      const e = leases.get(key);
      if (!e) return;
      // Force: the renew tick is exactly the case the debounce must not eat.
      fire(e, true);
      e.timer = setInterval(() => {
        const e2 = leases.get(key);
        if (e2) fire(e2, true);
      }, RENEW_MS);
      e.timerIsInterval = true;
    }, due);
  }
  let released = false;
  return {
    release() {
      // Idempotent: teardown paths overlap (a cancel can follow an error), and a
      // double release must not drop another holder's reference.
      if (released) return;
      released = true;
      const e = leases.get(key);
      if (!e) return;
      e.refs -= 1;
      if (e.refs <= 0) {
        if (e.timerIsInterval) clearInterval(e.timer);
        else clearTimeout(e.timer);
        leases.delete(key);
      }
    },
  };
}
