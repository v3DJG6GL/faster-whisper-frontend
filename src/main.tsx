import React from "react";
import ReactDOM from "react-dom/client";

// Self-hosted OFL fonts (bundled — works fully offline inside the Tauri WebView).
import "@fontsource-variable/hubot-sans";
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/geist-mono";

import "./app.css";
import App from "./App";
import Overlay from "./Overlay";
import QuickAdd from "./QuickAdd";
import { initKeyboardLayout } from "./lib/keyboardLayout";
import { applyTheme } from "./lib/theme";

type WindowLabel = "main" | "overlay" | "quickadd";

/** Which Tauri window is this document running in? Falls back to "main" outside Tauri. */
function detectWindowLabel(): WindowLabel {
  // Synchronous read of Tauri v2 internals (no import needed; undefined in a browser).
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (label === "overlay" || label === "quickadd") return label;
  if (label) return "main";
  // Browser preview: allow forcing a secondary window via the hash.
  if (window.location.hash.includes("overlay")) return "overlay";
  if (window.location.hash.includes("quickadd")) return "quickadd";
  return "main";
}

const label = detectWindowLabel();
document.body.dataset.window = label;
// Learn the user's keyboard layout (QWERTZ etc.) so shortcut chips show the keys on
// their keycaps, not the physical US-QWERTY positions event.code reports.
initKeyboardLayout();
if (label === "overlay" || label === "quickadd") {
  // Initial guess before any data arrives: resolve "auto" against the OS scheme (the
  // config isn't loaded yet). The chip then follows the theme broadcast on
  // `dictation://update` (Overlay.tsx); the quick-add window applies the loaded
  // config's setting on every summon (QuickAdd.tsx).
  applyTheme("auto");
}

const Root = label === "overlay" ? <Overlay /> : label === "quickadd" ? <QuickAdd /> : <App />;
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{Root}</React.StrictMode>,
);
