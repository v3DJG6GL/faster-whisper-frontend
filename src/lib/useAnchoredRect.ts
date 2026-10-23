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
 * it through scrolling, resizing and the host's own re-renders. null while closed or before the first measure.
 */
export function useAnchoredRect(ref: RefObject<HTMLElement | null>, open: boolean): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  // `fresh`: commit a new object even when the anchor didn't move. A resize must re-render the
  // popover regardless — popoverBox reads the viewport size at render (up/down, `bottom`, room,
  // the right-edge clamp), and a height-only resize leaves the anchor where it was.
  const place = useCallback(
    (fresh: boolean) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Every scroll in the page lands here (capture phase), including scrolling inside the
      // popover itself: keep the same object while the anchor hasn't moved, so nothing re-renders.
      setRect((prev) =>
        !fresh && prev && prev.left === r.left && prev.top === r.top && prev.bottom === r.bottom && prev.width === r.width
          ? prev
          : { left: r.left, top: r.top, bottom: r.bottom, width: r.width },
      );
    },
    [ref],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const onScroll = () => place(false);
    const onResize = () => place(true);
    place(true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      // Drop the old box, so a reopen renders unplaced until the re-measure above lands
      // (before paint) instead of briefly working from where the anchor used to be.
      setRect(null);
    };
  }, [open, place]);
  // A layout shift with no scroll or resize moves the anchor too (ticking a language adds a chip
  // before a multi-select's trigger and reflows its row): re-measure after every host render
  // while open. place(false) keeps the same object when nothing moved, so it cannot loop.
  useLayoutEffect(() => {
    if (open) place(false);
  });
  // The close commit itself already reports null (the cleanup's reset lands one render later).
  return open ? rect : null;
}

/**
 * Where a portaled popover sits at its anchor: below it, or above when the room below is under
 * `minRoom` and there is more above; never narrower than the anchor nor than `minWidth`, kept
 * 8 px inside the viewport. `align: "end"` lines its right edge up with the anchor's. `room` is
 * the height left on the chosen side (for capping a list).
 *
 * `grow`: the width is the content's (`max-content`), that floor its `minWidth`, so a long row
 * widens the popover instead of being cut to the anchor's width. It grows toward the side with
 * more room — leftward from the anchor's right edge when the anchor sits in the viewport's right
 * half (a settings row's right-aligned field), else rightward from its left edge — and
 * `maxWidth` stops it 8 px short of that side's viewport edge, where its rows truncate as a last
 * resort. `align` is ignored then.
 */
export function popoverBox(
  rect: AnchorRect,
  {
    minWidth,
    minRoom = 320,
    align = "start",
    grow = false,
  }: { minWidth: number; minRoom?: number; align?: "start" | "end"; grow?: boolean },
): { style: CSSProperties; room: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(Math.max(rect.width, minWidth), vw - 16);
  const below = vh - rect.bottom - 12;
  const above = rect.top - 12;
  const up = below < minRoom && above > below;
  const vertical = up ? { bottom: vh - rect.top + 4 } : { top: rect.bottom + 4 };
  if (grow) {
    // Pinned by `right`, the browser grows it leftward. The inset is clamped like the fixed-width
    // `left` below, so the floor always fits between it and the far side's 8 px margin.
    const leftward = rect.left + rect.width / 2 > vw / 2;
    const inset = Math.max(8, Math.min(leftward ? vw - rect.left - rect.width : rect.left, vw - width - 8));
    const edge = leftward ? { right: inset } : { left: inset };
    const maxWidth = vw - inset - 8;
    return {
      room: up ? above : below,
      style: { position: "fixed", ...edge, width: "max-content", minWidth: width, maxWidth, zIndex: 70, ...vertical },
    };
  }
  const left = align === "end" ? rect.left + rect.width - width : rect.left;
  return {
    room: up ? above : below,
    style: {
      position: "fixed",
      left: Math.max(8, Math.min(left, vw - width - 8)),
      width,
      zIndex: 70,
      ...vertical,
    },
  };
}
