import { useEffect, type DependencyList } from "react";

// Subscribe to a Tauri event for the component's lifetime. React StrictMode (dev) runs the cleanup
// BEFORE the listen() promise resolves; without the cancelled-guard the first listener is never
// removed, so every event fires its handler twice (double sound + duplicate sessions). `subscribe`
// is recreated each render, so only `deps` drive the effect.
export function useTauriListener(subscribe: () => Promise<() => void>, deps: DependencyList) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void subscribe()
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {}); // a rejected dynamic import / listen() must not surface as an unhandled rejection
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
