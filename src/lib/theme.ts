// Theme resolution: the persisted setting is "dark" | "light" | "auto", the DOM only
// ever sees the two concrete tokens (app.css [data-theme="…"]). "auto" follows the OS
// via prefers-color-scheme — WebView2 reflects the Windows app mode, WebKitGTK the
// desktop color-scheme — so a light-mode machine gets a light app out of the box.
// Every webview (main, chip, quick-add) resolves independently: same OS, same answer.

import type { ThemeName } from "./types";

const LIGHT_MQ = "(prefers-color-scheme: light)";

export function resolvedTheme(t: ThemeName): "dark" | "light" {
  if (t !== "auto") return t;
  return window.matchMedia(LIGHT_MQ).matches ? "light" : "dark";
}

/** Stamp the resolved theme on the document root (the only place data-theme is set). */
export function applyTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = resolvedTheme(t);
}

/** Re-apply on live OS scheme changes while `get()` says "auto". Returns the cleanup. */
export function watchSystemTheme(get: () => ThemeName): () => void {
  const mq = window.matchMedia(LIGHT_MQ);
  const onChange = () => {
    if (get() === "auto") applyTheme("auto");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
