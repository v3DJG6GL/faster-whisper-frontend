import React from "react";
import ReactDOM from "react-dom/client";

// Self-hosted OFL fonts (bundled — works fully offline inside the Tauri WebView).
import "@fontsource-variable/hubot-sans";
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/geist-mono";
// The live-dictation preview's "typed into your app" sample (latin 400 only).
import "@fontsource/special-elite/latin-400.css";

import "./app.css";
import App from "./App";
import Overlay from "./Overlay";
import QuickAdd from "./QuickAdd";
import LangPick from "./LangPick";
import { initKeyboardLayout } from "./lib/keyboardLayout";
import { applyTheme } from "./lib/theme";
import { watchWindowVisibility } from "./lib/windowVisibility";

/** The standalone secondary windows; each mounts its own root instead of <App/>. */
const AUX_WINDOWS = ["overlay", "quickadd", "langpick"] as const;
type AuxWindow = (typeof AUX_WINDOWS)[number];
type WindowLabel = "main" | AuxWindow;
const isAuxWindow = (l: string): l is AuxWindow => (AUX_WINDOWS as readonly string[]).includes(l);

/** Which Tauri window is this document running in? Falls back to "main" outside Tauri. */
function detectWindowLabel(): WindowLabel {
  // Synchronous read of Tauri v2 internals (no import needed; undefined in a browser).
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (label) return isAuxWindow(label) ? label : "main";
  // Browser preview: allow forcing a secondary window via the hash.
  return AUX_WINDOWS.find((w) => window.location.hash.includes(w)) ?? "main";
}

const label = detectWindowLabel();
document.body.dataset.window = label;
// Before any window mounts its drift driver: the three hidden-at-launch windows start paused.
watchWindowVisibility(label);
// Learn the user's keyboard layout (QWERTZ etc.) so shortcut chips show the keys on
// their keycaps, not the physical US-QWERTY positions event.code reports.
initKeyboardLayout();
if (label !== "main") {
  // Initial guess before any data arrives: resolve "auto" against the OS scheme (the
  // config isn't loaded yet). The chip then follows the theme broadcast on
  // `dictation://update` (Overlay.tsx); the quick-add and language-picker windows apply
  // the loaded config's setting on every summon (QuickAdd.tsx, LangPick.tsx).
  applyTheme("auto");
}

const Root =
  label === "overlay" ? <Overlay />
  : label === "quickadd" ? <QuickAdd />
  : label === "langpick" ? <LangPick />
  : <App />;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{Root}</React.StrictMode>,
);
