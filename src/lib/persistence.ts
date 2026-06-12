import { useApp } from "./store";
import { isTauri, loadConfig, saveConfig, reregisterShortcuts } from "./api";

/**
 * Load persisted config on startup, then auto-save (debounced) whenever
 * settings / profiles / modes change. No-op outside Tauri.
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
  let pendingModeChange = false;
  useApp.subscribe((state, prev) => {
    if (
      state.settings === prev.settings &&
      state.profiles === prev.profiles &&
      state.modes === prev.modes
    ) {
      return;
    }
    if (state.modes !== prev.modes) pendingModeChange = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useApp.getState();
      const reReg = pendingModeChange;
      pendingModeChange = false;
      saveConfig({ settings: s.settings, profiles: s.profiles, modes: s.modes })
        .then(() => (reReg ? reregisterShortcuts() : undefined))
        .catch((e) => console.error("saveConfig failed", e));
    }, 400);
  });
}
