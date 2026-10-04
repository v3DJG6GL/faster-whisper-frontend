import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/** The viewport box of the element a portaled popover hangs off. */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/**
 * Track an anchor's viewport position while its popover is open, so a popover PORTALED to
 * <body> (and fixed-positioned there, out of reach of an ancestor's `overflow-hidden`) follows
 * it through scrolling and resizing. null while closed or before the first measure.
 */
export function useAnchoredRect(ref: RefObject<HTMLElement | null>, open: boolean): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
  }, [ref]);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);
  return rect;
}
