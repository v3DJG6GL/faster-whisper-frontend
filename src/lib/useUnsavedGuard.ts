// The editor half of the unsaved-work guard: registers with navGuard, covers
// quitting the app, and hands the screen the state its confirm dialog needs.
//
// Lives in the EDITOR component (not the list screen) because only the editor
// holds the draft and knows how to save it — "Save and leave" has to be able to
// do both, in that order, from one click.

import { useEffect, useRef, useState } from "react";
import { setNavGuard } from "./navGuard";
import { stableStringify } from "./stable";

/** True when the draft differs from what the editor opened with. Key order and
 *  `undefined` members are normalized away, so typing into a field and clearing
 *  it again reads as clean. */
export function isDirty(draft: unknown, initial: unknown): boolean {
  return stableStringify(draft) !== stableStringify(initial);
}

export interface UnsavedGuard {
  /** A navigation (or an Esc / back press) is waiting on an answer. */
  asking: boolean;
  /** Run an exit that belongs to the editor itself — the back arrow, Esc, the
   *  Cancel button. Clean drafts leave with no friction at all. */
  guardExit: (exit: () => void) => void;
  /** Discard changes and go. */
  leave: () => void;
  /** Keep editing; stay where we are. */
  stay: () => void;
  /** Save first, then go. Pass the editor's own save; an async one (the
   *  Backends editor writes the API key to the keyring first) is awaited, so
   *  the navigation can't tear the editor down mid-write. */
  saveAndLeave: (save: () => void | Promise<void>) => void;
}

export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [pending, setPending] = useState<{ run: () => void } | null>(null);

  // Read at navigation time: the guard is registered once, but `dirty` changes
  // on every keystroke.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(
    () =>
      setNavGuard({
        dirty: () => dirtyRef.current,
        ask: (proceed) => setPending({ run: proceed }),
      }),
    [],
  );

  // Quitting the app (or a reload in `pnpm dev`) isn't a route change, so it
  // needs the platform's own prompt. Registered only while dirty — an
  // always-on handler makes every quit sticky.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const take = () => {
    const p = pending;
    setPending(null);
    return p;
  };

  return {
    asking: pending !== null,
    guardExit: (exit) => {
      if (dirtyRef.current) setPending({ run: exit });
      else exit();
    },
    leave: () => take()?.run(),
    stay: () => setPending(null),
    saveAndLeave: (save) => {
      const p = take();
      const done = save();
      if (done && typeof done.then === "function") void done.then(() => p?.run());
      else p?.run();
    },
  };
}
