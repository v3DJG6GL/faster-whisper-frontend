/** The indexes a virtualized list renders: the virtualizer's window plus one
 *  pinned row that must always be in the page (the viewer's follow and its
 *  Export→Read re-centre look the active segment's row up by id). Before the
 *  scroll box is known the window is empty — React attaches a fresh box's ref
 *  only after its children's effects — so a screenful around the pin (or from
 *  the top) stands in until the virtualizer's first real range. */
export function rowsToRender(range: number[], pin: number, count: number, fallback = 16): number[] {
  if (!range.length) {
    const start = Math.max(0, Math.min(pin, count - 1) - fallback);
    const end = Math.min(count - 1, Math.max(pin, 0) + fallback);
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, k) => start + k);
  }
  if (pin < 0 || pin >= count || range.includes(pin)) return range;
  return pin < range[0] ? [pin, ...range] : [...range, pin];
}
