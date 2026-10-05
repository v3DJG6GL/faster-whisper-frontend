// The heat grids' (calendar, busy panel) hooks and cell classes; heatGrid.tsx holds
// their components (the tooltip shell and the level legend).
import {
  useCallback, useEffect, useState, type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";

/* ── cell tooltip: instant, follows the cursor or the focused cell ───────── */

export interface CellTipState { i: number; x: number; y: number }

/** Delegated hover + focus for a grid of level cells. Cells carry `data-i`; the wrapper is
 *  `relative`. The panel resolves `i` against its model and renders the content. */
export function useCellTip() {
  const [tip, setTip] = useState<CellTipState | null>(null);
  const at = (host: HTMLDivElement, el: HTMLElement, cx: number, cy: number) => {
    const box = host.getBoundingClientRect();
    setTip({ i: Number(el.dataset.i), x: cx - box.left + host.scrollLeft, y: cy - box.top + host.scrollTop });
  };
  const onMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i) { setTip(null); return; }
    at(e.currentTarget, el, e.clientX, e.clientY);
  }, []);
  const onLeave = useCallback(() => setTip(null), []);
  // Keyboard (D34): the tooltip sits over the focused cell's centre.
  const onFocus = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i) return;
    const r = el.getBoundingClientRect();
    at(e.currentTarget, el, r.left + r.width / 2, r.top + r.height / 2);
  }, []);
  const onBlur = useCallback((e: ReactFocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTip(null);
  }, []);
  return { tip, onMove, onLeave, onFocus, onBlur };
}


/** Roving tabindex for a grid of `data-i` cells (D34): one tab stop, the arrow keys move by
 *  `dx` (left/right) and `dy` (up/down) indexes, Home/End jump. */
export function useRovingGrid(count: number, dx: number, dy: number) {
  const [focusIdx, setFocusIdx] = useState(0);
  useEffect(() => { if (focusIdx >= count) setFocusIdx(0); }, [count, focusIdx]);
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest?.("[data-i]") as HTMLElement | null;
    if (!el?.dataset.i || count === 0) return;
    const i = Number(el.dataset.i);
    const step = e.key === "ArrowLeft" ? -dx : e.key === "ArrowRight" ? dx : e.key === "ArrowUp" ? -dy : e.key === "ArrowDown" ? dy : e.key === "Home" ? -i : e.key === "End" ? count - 1 - i : null;
    if (step === null) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(count - 1, i + step));
    const target = e.currentTarget.querySelector<HTMLElement>(`[data-i="${next}"]`);
    if (target) { setFocusIdx(next); target.focus(); }
  }, [count, dx, dy]);
  return { focusIdx, onKeyDown };
}

/** The hovered / focused cell's highlight, driven from the tooltip's index rather than
 *  `:hover`: Tailwind v4 wraps every hover utility in `@media (hover: hover)`, which
 *  WebKitGTK does not always report, and a ring (box-shadow) cannot be undone by the
 *  cells' `outline-none`. */
export const CELL_HOT = "z-10 ring-2 ring-text ring-offset-1 ring-offset-panel";

export const CELL_HOVER = "hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-text relative hover:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-text focus-visible:z-10";

export const LEVEL_BG = ["var(--c-surface-2)", "var(--c-cal-1)", "var(--c-cal-2)", "var(--c-cal-3)", "var(--c-cal-4)"] as const;
