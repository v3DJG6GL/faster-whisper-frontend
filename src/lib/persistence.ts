import { useApp } from "./store";
import { isTauri, loadConfig, saveConfig, reregisterShortcutsUnlessCapturing } from "./api";
import { conflicts, quickAddPeer } from "./conflicts";

/**
 * Load persisted config on startup, then auto-save (debounced) whenever
 * settings / backends / profiles change. No-op outside Tauri.
 */
let started = false;

export async function initConfig(): Promise<void> {
  // Run once. React StrictMode double-invokes the App effect in dev; without this guard a
  // second initConfig would register a second auto-save subscriber (doubled saveConfig +
  // reregisterShortcuts on every change). Mirrors initOverlayController / initUsageController.
  if (!isTauri || started) return;
  started = true;

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
    // The load failed at the IPC level (Rust load() itself returns a valid config and backs up an
    // unreadable one). Auto-save is still armed below holding the seeded defaults, so warn that the
    // saved settings couldn't be loaded and saving now may overwrite them.
    useApp
      .getState()
      .setSaveError("Couldn’t load your saved settings — saving now may overwrite them. Restart to retry.");
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
      state.settings.general.evdevEnabled !== prev.settings.general.evdevEnabled ||
      state.settings.general.quickAddHotkey !== prev.settings.general.quickAddHotkey
    ) {
      pendingBindingChange = true;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const s = useApp.getState();
      // Don't persist or register a conflicting binding set — the last good config stays live
      // until the user resolves it. Surface the freeze GLOBALLY via the save banner: otherwise
      // it's silent and unrelated settings/backends edits are dropped, with only the Profiles
      // screen hinting why. Keep pendingBindingChange so the fix triggers a reregister.
      // Include the quick-add chord as a synthetic peer (mirrors the capture-time check in
      // Profiles.tsx / the Settings quick-add row). It shares the same chord namespace as profile
      // chords in BOTH hotkey backends (evdev drops a dup, the plugin last-wins clobbers), but the
      // enable toggle bypasses capture — so an enabled profile could silently collide with quick-add
      // unless the save-gate sees it too.
      const qa = s.settings.general.quickAddHotkey;
      const conflictPeers = qa.length > 0 ? [...s.profiles, quickAddPeer(qa)] : s.profiles;
      // evdev off ⇒ the plugin backend registers and can't tell modifier sides apart, so collapse
      // L/R for conflict detection (else two side-only-different chords pass here yet one silently
      // never registers). Mirrors the capture-time + per-card checks.
      if (conflicts(conflictPeers, !s.settings.general.evdevEnabled).length > 0) {
        useApp
          .getState()
          .setSaveError("A shortcut is used by two bindings — resolve the conflict to resume saving.");
        return;
      }
      const reReg = pendingBindingChange;
      pendingBindingChange = false;
      saveConfig({ settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules, version: 2 })
        .then(
          () => {
            // The write landed — clear any prior failure banner, THEN re-register. Re-registration
            // has its OWN catch: a reregister failure is NOT data loss (the config was persisted
            // fine), so it must never raise the "couldn't save your settings" banner below.
            useApp.getState().setSaveError(null);
            // Use the capture-aware variant: a debounced save left pending by an edit just before the
            // user enters chord-capture can resolve DURING the capture window, and a plain reregister
            // would re-arm the hotkeys mid-capture (the next keypress would both rebind AND fire
            // dictation). When no capture is active it re-arms normally; the capture's own teardown
            // re-arms when it ends. Mirrors cancelLive's use of the same variant.
            if (reReg) void reregisterShortcutsUnlessCapturing().catch((e) => console.error("reregister failed", e));
          },
          (e) => {
            // A real disk/IPC failure (full/read-only disk, perms) — the in-memory store still
            // shows the change, but it wasn't written, so warn the user it may be lost on restart.
            console.error("saveConfig failed", e);
            useApp.getState().setSaveError(e instanceof Error ? e.message : String(e));
            // The write didn't land, so the re-register never ran — restore the intent (like the
            // conflict early-return does) so the NEXT successful save re-registers the bindings.
            // Otherwise a later non-binding save would persist the new chord to disk but leave it
            // not-live (reReg=false) until an app restart.
            if (reReg) pendingBindingChange = true;
          },
        );
    }, 400);
  });
}
