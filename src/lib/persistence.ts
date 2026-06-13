import { useApp } from "./store";
import { isTauri, loadConfig, saveConfig, reregisterShortcuts } from "./api";
import { conflicts } from "./conflicts";

/**
 * Load persisted config on startup, then auto-save (debounced) whenever
 * settings / backends / profiles change. No-op outside Tauri.
 */
export async function initConfig(): Promise<void> {
  if (!isTauri) return;

  try {
    const cfg = await loadConfig();
    if (cfg) useApp.getState().hydrate(cfg);
  } catch (e) {
    console.error("loadConfig failed", e);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingBindingChange = false;
  useApp.subscribe((state, prev) => {
    if (
      state.settings === prev.settings &&
      state.backends === prev.backends &&
      state.profiles === prev.profiles
    ) {
      return;
    }
    // Re-apply bindings when the profiles' chords change OR the evdev backend is
    // toggled (which owner — plugin vs evdev — must switch). reregister runs after
    // the save resolves, so the Rust side reads the just-persisted config (no race).
    if (
      state.profiles !== prev.profiles ||
      state.settings.general.evdevEnabled !== prev.settings.general.evdevEnabled
    ) {
      pendingBindingChange = true;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useApp.getState();
      // Don't persist or register a conflicting binding set — the Shortcuts/Profiles
      // UI shows a banner; the last good config stays live until the user resolves it.
      // Keep pendingBindingChange so the fix triggers a reregister.
      if (conflicts(s.profiles).length > 0) return;
      const reReg = pendingBindingChange;
      pendingBindingChange = false;
      saveConfig({ settings: s.settings, backends: s.backends, profiles: s.profiles })
        .then(() => (reReg ? reregisterShortcuts() : undefined))
        .catch((e) => console.error("saveConfig failed", e));
    }, 400);
  });
}
