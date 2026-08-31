// Pairing a live phrase with the capture row the server minted for it,
// extracted from streaming.ts so it can be TESTED (nothing in this repo mocks
// Tauri, so anything reachable only through a WS event handler is not).
//
// The server holds each utterance's log receipt open waiting for our translate
// call, and the capture id is how it links the two halves into one block. The
// id rides its OWN frame, because the `final` frame is emitted before the
// capture row is written and the id does not exist yet at that point.
//
// This used to be a single "most recent id" slot, taken by whichever phrase
// asked first, and that is wrong in both directions:
//
//   • The server does not mint a capture for every utterance — it samples, and
//     caps by count, bytes, duration and free disk. So the Nth id is not the
//     Nth utterance's, and a positional match silently drifts.
//   • The translate runs INSIDE the inject queue, one `resolveTarget` IPC hop
//     after the final. A phrase could therefore take the NEXT utterance's id
//     (claiming a receipt still being written, and leaving its own parked until
//     the server's 90 s idle sweep), or find `null` because an earlier phrase
//     had already spent it.
//
// Both frames carry the server's utterance ordinal, so keying on it makes the
// pairing exact instead of positional. Best-effort throughout: an older backend
// sends no ordinal, and a translation carrying no id simply completes nothing —
// which is the pre-existing behaviour.

/** How long a phrase waits for its own capture id before giving up on the
 *  receipt. The frame is normally already here — the queue's `resolveTarget`
 *  hop costs tens of milliseconds — so this only covers a server that writes
 *  the capture row slowly, and giving up costs nothing but one unclaimed
 *  receipt on the server side. */
export const CAPTURE_ID_WAIT_MS = 1_500;

export interface CaptureIdBook {
  /** A `captured` frame landed. */
  resolve(utterance: number, id: string): void;
  /** This utterance's id, waiting briefly if its frame hasn't landed yet.
   *  Removed once handed out — each held receipt is claimed exactly once.
   *  `null` for an utterance that will never have one (the one-shot, an older
   *  backend, a capture the server declined to write). */
  take(utterance: number | null): Promise<string | null>;
  /** The session is over: drop every pending id and unpark every waiter, so no
   *  phrase of the NEXT session can be handed this one's receipt. */
  reset(): void;
}

export function newCaptureIdBook(
  o: {
    waitMs?: number;
    setTimer?: (cb: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  } = {},
): CaptureIdBook {
  const waitMs = o.waitMs ?? CAPTURE_ID_WAIT_MS;
  const setTimer = o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  /** Ids that arrived before anyone asked. */
  const arrived = new Map<number, string>();
  /** Phrases parked on an id that hasn't arrived, by ordinal. */
  const waiters = new Map<number, Array<(id: string | null) => void>>();

  return {
    resolve(utterance, id) {
      if (!id) return;
      const waiting = waiters.get(utterance);
      if (waiting?.length) {
        waiters.delete(utterance);
        // Exactly one claimant per receipt: the first waiter takes the id, and
        // any other (there is none today) is released empty-handed rather than
        // handed a duplicate that would claim the same receipt twice.
        const [first, ...rest] = waiting;
        first(id);
        for (const cb of rest) cb(null);
        return;
      }
      arrived.set(utterance, id);
    },

    take(utterance) {
      if (utterance === null) return Promise.resolve(null);
      const have = arrived.get(utterance);
      if (have !== undefined) {
        arrived.delete(utterance);
        return Promise.resolve(have);
      }
      return new Promise((resolve) => {
        let settled = false;
        let handle: unknown;
        const settle = (id: string | null) => {
          if (settled) return;
          settled = true;
          clearTimer(handle);
          resolve(id);
        };
        const list = waiters.get(utterance) ?? [];
        list.push(settle);
        waiters.set(utterance, list);
        handle = setTimer(() => {
          // Drop OUR waiter only — a second phrase parked on the same ordinal
          // must not lose its callback to our timeout.
          const cur = waiters.get(utterance);
          if (cur) {
            const i = cur.indexOf(settle);
            if (i >= 0) cur.splice(i, 1);
            if (!cur.length) waiters.delete(utterance);
          }
          settle(null);
        }, waitMs);
      });
    },

    reset() {
      arrived.clear();
      // Unpark before clearing, so a phrase still awaiting an id resolves
      // (with null) instead of hanging until its own timeout — a session
      // teardown must not leave the inject queue blocked.
      for (const list of waiters.values()) for (const cb of list) cb(null);
      waiters.clear();
    },
  };
}
