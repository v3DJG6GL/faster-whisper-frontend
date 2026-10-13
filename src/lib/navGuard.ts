// Unsaved-work guard for in-app navigation.
//
// The editor screens (Profiles / Backends / App rules / Dictionary) hold their
// draft in local state, so clicking a sidebar entry mid-edit used to throw the
// work away in silence. React Router's own `useBlocker` is data/framework-mode
// only and the app runs a declarative <HashRouter>, so the interception happens
// where the navigation is ISSUED instead: every route change reachable while an
// editor is mounted asks here first — the sidebar links, the overlay's
// app://navigate bridge (App.tsx NavigationBridge) and the failure doorway's
// "View logs" button (App.tsx LogsDoorwayBanner). A new in-app link must too.
// History traversal (mouse back/forward buttons, Alt+Left/Right, a swipe) is
// not issued by the app, so App.tsx HistoryTraversalGuard asks here on its
// popstate, puts the editor's location back before the router can leave it, and
// steps back onto the traversal's target if the user then chooses to leave.
//
// One guard at a time — only one editor screen is ever mounted, since each one
// is its own route (and a list's editor replaces the list it belongs to).

import { IS_LINUX, IS_WINDOWS } from "./platform";

/** Is this key a keyboard history traversal — Browser Back/Forward, or Alt+Left/Right outside
 *  macOS (where Option+Arrow moves by word)? A field that keeps an uncommitted draft must commit
 *  it on one (blur), or the popstate guard reads a clean editor and lets it unmount — React
 *  fires no onBlur on unmount. The key itself still goes through, so the guard then asks. */
export function isHistoryTraversalKey(e: { key: string; altKey: boolean }): boolean {
  return (
    e.key === "BrowserBack" ||
    e.key === "BrowserForward" ||
    (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (IS_WINDOWS || IS_LINUX))
  );
}

interface NavGuard {
  /** Is there work that would be lost? Read at navigation time, not registration. */
  dirty: () => boolean;
  /** Put the question to the user; call `proceed` only if they choose to leave. */
  ask: (proceed: () => void) => void;
}

let active: NavGuard | null = null;

/** Register the open editor's guard. Returns the deregister fn — call it on
 *  unmount, and it's a no-op if another editor has since taken over. */
export function setNavGuard(g: NavGuard): () => void {
  active = g;
  return () => {
    if (active === g) active = null;
  };
}

/** Ask permission to navigate. Returns true when the caller may go ahead now;
 *  false means a guard has taken the question to the user and will run
 *  `proceed` itself if they agree. */
export function tryNavigate(proceed: () => void): boolean {
  if (!active || !active.dirty()) return true;
  active.ask(proceed);
  return false;
}
