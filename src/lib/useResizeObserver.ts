import { useLayoutEffect, useRef, type RefObject } from "react";

/** While `enabled`, call `onResize` with the element now — in a layout effect, so a
 *  measurement lands before paint — and again whenever its box changes. Always calls the
 *  latest `onResize`. */
export function useResizeObserver<E extends HTMLElement>(
  ref: RefObject<E | null>,
  onResize: (el: E) => void,
  enabled = true,
): void {
  const latest = useRef(onResize);
  latest.current = onResize;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    latest.current(el);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => latest.current(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
}
