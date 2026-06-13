import React from "react";
import ReactDOM from "react-dom/client";

// Self-hosted OFL fonts (bundled — works fully offline inside the Tauri WebView).
import "@fontsource-variable/hubot-sans";
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/geist-mono";

import "./app.css";
import App from "./App";
import Overlay from "./Overlay";

/** Which Tauri window is this document running in? Falls back to "main" outside Tauri. */
function detectWindowLabel(): "main" | "overlay" {
  // Synchronous read of Tauri v2 internals (no import needed; undefined in a browser).
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
  }).__TAURI_INTERNALS__;
  const label = internals?.metadata?.currentWindow?.label;
  if (label) return label === "overlay" ? "overlay" : "main";
  // Browser preview: allow forcing the overlay with #overlay
  if (window.location.hash.includes("overlay")) return "overlay";
  return "main";
}

const label = detectWindowLabel();
document.body.dataset.window = label;
if (label === "overlay") {
  // Initial default; the chip then follows the app theme broadcast on
  // `dictation://update` (see Overlay.tsx) before it's ever shown.
  document.documentElement.dataset.theme = "dark";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{label === "overlay" ? <Overlay /> : <App />}</React.StrictMode>,
);
