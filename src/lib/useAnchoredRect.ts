import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

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

/**
 * Where a portaled popover sits at its anchor: below it, or above when the room below is under
 * `minRoom` and there is more above; never narrower than the anchor nor than `minWidth`, kept
 * 8 px inside the viewport. `align: "end"` lines its right edge up with the anchor's. `room` is
 * the height left on the chosen side (for capping a list).
 */
export function popoverBox(
  rect: AnchorRect,
  { minWidth, minRoom = 320, align = "start" }: { minWidth: number; minRoom?: number; align?: "start" | "end" },
): { style: CSSProperties; room: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, minWidth), vw - 16);
  const below = vh - rect.bottom - 12;
  const above = rect.top - 12;
  const up = below < minRoom && above > below;
  const left = align === "end" ? rect.left + rect.width - width : rect.left;
  return {
    room: up ? above : below,
    style: {
      position: "fixed",
      left: Math.max(8, Math.min(left, vw - width - 8)),
      width,
      zIndex: 70,
      ...(up ? { bottom: vh - rect.top + 4 } : { top: rect.bottom + 4 }),
    },
  };
}
