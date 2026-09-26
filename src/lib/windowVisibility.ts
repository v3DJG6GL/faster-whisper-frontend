// Hold this window's accent drift while nobody can see it (theme.ts `setAccentDriftPaused`).
//
// Every webview lives for the whole app lifetime and is only ever hidden, so without this a
// hidden quick-add or picker kept restamping the accent 4× a second — a steady CPU cost, and
// memory the hidden page built up and never released. Two independent reasons, either of
// which pauses:
//   "window"   — Rust's own show/hide (`window://visibility`, winvis.rs). Exact, and the one
//                that also works where the page is never told (WebView2 on a hidden HWND).
//   "document" — the page's `visibilitychange` (WebKitGTK reports an unmapped or minimized
//                view as hidden).
//
// Runs once per document from main.tsx, outside React (StrictMode cannot double it).
//
// The same two reasons also answer `isWindowHidden()` for the rest of the page: the main
// window's usage poll (usage.ts) slows down while nobody can see it.

import { setAccentDriftPaused } from "./theme";

export interface VisibilityDeps {
  doc: { readonly visibilityState: DocumentVisibilityState; addEventListener(type: "visibilitychange", fn: () => void): void };
  /** Absent outside Tauri (browser preview): only the document signal applies. */
  tauri?: {
    listen: (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;
    isVisible: () => Promise<boolean>;
  };
}

/** The windows tauri.conf.json creates hidden (`visible: false`): they boot paused. */
const BOOTS_HIDDEN = new Set(["overlay", "quickadd", "langpick"]);

type Reason = "window" | "document";
const hiddenBy = new Set<Reason>();
const hiddenListeners = new Set<(hidden: boolean) => void>();

/** Hidden for either reason. False until `watchWindowVisibility` has run. */
export function isWindowHidden(): boolean {
  return hiddenBy.size > 0;
}

/** Called with the new state whenever `isWindowHidden()` flips. Returns the unsubscribe. */
export function onWindowHiddenChange(fn: (hidden: boolean) => void): () => void {
  hiddenListeners.add(fn);
  return () => void hiddenListeners.delete(fn);
}

function setHidden(reason: Reason, hidden: boolean): void {
  const before = isWindowHidden();
  if (hidden) hiddenBy.add(reason);
  else hiddenBy.delete(reason);
  setAccentDriftPaused(reason, hidden);
  const now = isWindowHidden();
  if (now !== before) for (const fn of hiddenListeners) fn(now);
}

export function _resetWindowVisibilityForTests(): void {
  hiddenBy.clear();
  hiddenListeners.clear();
}

export function watchWindowVisibility(label: string, deps: VisibilityDeps = defaultDeps()): void {
  if (BOOTS_HIDDEN.has(label)) setHidden("window", true);

  const { doc } = deps;
  const onDoc = () => setHidden("document", doc.visibilityState === "hidden");
  onDoc();
  doc.addEventListener("visibilitychange", onDoc);

  const tauri = deps.tauri;
  if (!tauri) return;
  // Bumped by every event, so the one-off query below can tell it was overtaken: a show or
  // hide that lands while `isVisible()` is in flight is newer than its answer.
  let seq = 0;
  void tauri
    .listen("window://visibility", (e) => {
      seq++;
      setHidden("window", e.payload !== true);
    })
    .then(async () => {
      // An emit with no listener is dropped, never queued: a show or hide from before this
      // listener existed (start minimized, a summon in the first moments of life) left no
      // trace — ask once. A failed query fails OPEN (drift runs, as it always did before).
      const asked = seq;
      const visible = await tauri.isVisible().catch(() => true);
      if (seq === asked) setHidden("window", !visible);
    })
    .catch(() => setHidden("window", false));
}

function defaultDeps(): VisibilityDeps {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return {
    doc: document,
    tauri: inTauri
      ? {
          listen: async (event, cb) => (await import("@tauri-apps/api/event")).listen(event, cb),
          isVisible: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().isVisible(),
        }
      : undefined,
  };
}
