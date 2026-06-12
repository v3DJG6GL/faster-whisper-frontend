import { useApp } from "./store";
import { isTauri, loadConfig, saveConfig } from "./api";

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
  useApp.subscribe((state, prev) => {
    if (
      state.settings === prev.settings &&
      state.profiles === prev.profiles &&
      state.modes === prev.modes
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useApp.getState();
      saveConfig({ settings: s.settings, profiles: s.profiles, modes: s.modes }).catch((e) =>
        console.error("saveConfig failed", e),
      );
    }, 400);
  });
}
