import { useEffect, useRef, type RefObject } from "react";

/** While `open`, a mouse press outside every element in `refs` calls `onOutside` — a popover's
 *  click-away close. Bound once per opening; always calls the latest `onOutside`. */
export function useOutsidePress(refs: RefObject<HTMLElement | null>[], open: boolean, onOutside: () => void): void {
  const latest = useRef({ refs, onOutside });
  latest.current = { refs, onOutside };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!latest.current.refs.some((r) => r.current?.contains(t))) latest.current.onOutside();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
}
