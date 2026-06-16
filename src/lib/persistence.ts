import { useApp } from "./store";
import { isTauri, loadConfig, saveConfig, reregisterShortcuts } from "./api";
import { conflicts } from "./conflicts";

/**
 * Load persisted config on startup, then auto-save (debounced) whenever
 * settings / backends / profiles change. No-op outside Tauri.
 */
export async function initConfig(): Promise<void> {
  if (!isTauri) return;

  // Arm auto-save ONLY after the initial load resolves. The store boots with seeded
  // defaults ("Local server" + two default profiles); persisting before (or instead
  // of) a successful load — e.g. a change landing during the load window — would
  // overwrite the real on-disk config with those defaults. (In dev, editing store.ts
  // hot-reloads it back to defaults; this guard plus the post-load subscribe keep the
  // saved config safe, but you still must restart the app to see your config again.)
  let hydrated = false;
  try {
    const cfg = await loadConfig();
    if (cfg) useApp.getState().hydrate(cfg);
  } catch (e) {
    console.error("loadConfig failed", e);
  } finally {
    hydrated = true;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingBindingChange = false;
  useApp.subscribe((state, prev) => {
    if (!hydrated) return;
    if (
      state.settings === prev.settings &&
      state.backends === prev.backends &&
      state.profiles === prev.profiles &&
      state.appRules === prev.appRules
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
      saveConfig({ settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules })
        .then(() => (reReg ? reregisterShortcuts() : undefined))
        .catch((e) => console.error("saveConfig failed", e));
    }, 400);
  });
}
