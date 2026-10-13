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
// popstate and puts the editor's location back before the router can leave it.
//
// One guard at a time — only one editor screen is ever mounted, since each one
// is its own route (and a list's editor replaces the list it belongs to).

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

/** Is there work a navigation would lose right now? For a handler that has to decide on the spot
 *  (cancel a mouse back-button press) without putting the question to the user. */
export function navGuardDirty(): boolean {
  return !!active && active.dirty();
}
