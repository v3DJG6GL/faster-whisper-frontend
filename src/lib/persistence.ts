import { useApp, CONFIG_VERSION } from "./store";
import { isTauri, loadConfig, saveConfig, reregisterShortcutsUnlessCapturing, evdevStatus } from "./api";
import { conflicts, withQuickAddPeer } from "./hotkeyConflicts";
import { IS_WINDOWS } from "./platform";
import type { Profile } from "./types";

/**
 * Load persisted config on startup, then auto-save (debounced) whenever
 * settings / backends / profiles change. No-op outside Tauri.
 */
let started = false;

/** Resolves once the initial load hydrated the store AND the auto-save
 *  subscriber is armed (or immediately outside Tauri). The sync engine awaits
 *  this so its startup pull merges against the real persisted state, and so a
 *  pull-apply's hydrate() is guaranteed to be persisted by the subscriber. */
let resolveConfigReady: () => void = () => {};
export const configReady: Promise<void> = new Promise((r) => {
  resolveConfigReady = r;
});

/** The startup "load" notice (settings reset / load failed), remembered so a later save
 *  failure (or a hotkey-conflict freeze) that takes the banner slot can't erase it for good:
 *  the next successful save puts it back. Dismissing the banner forgets it. */
let loadNotice: string | null = null;

/** Set once initConfig has armed the auto-save: lands the debounced save now. */
let flushPendingSave: (() => Promise<void>) | null = null;

/** Land the debounced config save now (the quit handshake / session end): a pending 400 ms
 *  timer runs at once, else an in-flight save is awaited. Never rejects — a failed save keeps
 *  its banner. Resolves at once outside Tauri and before initConfig armed the auto-save. */
export function flushConfigSave(): Promise<void> {
  return flushPendingSave ? flushPendingSave() : Promise.resolve();
}

/** What every hotkey backend reads from a profile (evdev / Windows hook `chords_from`, the
 *  plugin's `register_from_config`), in config order — the first of a duplicate chord wins. */
function bindingSig(ps: Profile[]): string {
  return JSON.stringify(ps.map((p) => [p.id, p.enabled, p.activation, p.hotkey]));
}

function raiseLoadNotice(msg: string): void {
  loadNotice = msg;
  useApp.getState().setSaveError(msg, "load");
}

export async function initConfig(): Promise<void> {
  // Run once. React StrictMode double-invokes the App effect in dev; without this guard a
  // second initConfig would register a second auto-save subscriber (doubled saveConfig +
  // reregisterShortcuts on every change). Mirrors initOverlayController / initUsageController.
  if (!isTauri) {
    useApp.getState().setConfigLoaded();
    resolveConfigReady();
    return;
  }
  // A StrictMode re-entry must NOT resolve configReady — the FIRST call does,
  // after hydration + arming (else initSync starts against seeded defaults).
  if (started) return;
  started = true;

  // Arm auto-save ONLY after the initial load resolves. The store boots EMPTY
  // (no backends, no profiles — the first-run gate keys on that); persisting
  // before (or instead of) a successful load — e.g. a change landing during the
  // load window — would overwrite the real on-disk config with that empty
  // state. (In dev, editing store.ts
  // hot-reloads it back to defaults; this guard plus the post-load subscribe keep the
  // saved config safe, but you still must restart the app to see your config again.)
  let hydrated = false;
  try {
    const loaded = await loadConfig();
    if (loaded) {
      useApp.getState().hydrate(loaded.config);
      // Rust recovered from an unreadable / corrupt / forward-incompatible config by backing it up to
      // config.json.bak and loading defaults — surface that so the user knows their settings were reset
      // (and where the backup is), instead of a silent wipe the armed auto-save below then persists.
      if (loaded.backupFailed) {
        // No backup exists — Rust refuses every save this session, so don't promise one.
        raiseLoadNotice(
          "Your saved settings couldn’t be read and no backup could be made — changes won’t be saved this session. Fix access to config.json and restart the app.",
        );
      } else if (loaded.recovered) {
        raiseLoadNotice(
          "Your saved settings couldn’t be read and were reset — a backup was kept at config.json.bak.",
        );
      }
    }
  } catch (e) {
    console.error("loadConfig failed", e);
    // The load failed at the IPC level (Rust load() itself returns a valid config and backs up an
    // unreadable one). Auto-save is still armed below holding the EMPTY boot state — a save now
    // would wipe the on-disk config (and re-open the first-run gate on the next launch), so warn.
    raiseLoadNotice("Couldn’t load your saved settings — saving now may overwrite them. Restart to retry.");
    useApp.getState().setConfigLoadFailed();
  } finally {
    hydrated = true;
  }

  // Whether the evdev backend is actually PERMITTED. evdev is the live hotkey backend only when
  // enabled AND permitted; otherwise the plugin is live and collapses L/R modifier sides, so the
  // save-gate below must mirror Rust's !(enabled && permitted) collapse decision. Default false is
  // conservative (collapse until known, so a real side-only conflict is never missed); refreshed on
  // the evdev toggle below.
  let evdevPermitted = false;
  void evdevStatus()
    .then((st) => {
      evdevPermitted = st.permitted;
    })
    .catch(() => {});

  // The banner went away (the user dismissed it; the save path below never clears it while a
  // load notice is remembered — it restores it instead) ⇒ forget the load notice.
  useApp.subscribe((state, prev) => {
    if (prev.saveError && !state.saveError) loadNotice = null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingBindingChange = false;
  // The save issued last, until it settles — what a flush with no timer pending waits for.
  let inFlight: Promise<void> | null = null;
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
    // Re-apply bindings when the profiles' chords change (a rename, language or backend edit
    // leaves the binding signature alone — a rebind would tear down a held push-to-talk) OR the
    // evdev backend is toggled (which owner — plugin vs evdev — must switch), or when a quick-add list is
    // designated or cleared (apply_bindings arms the quick-add chord only while one is set).
    // The quick-add chord is compared by content too, for the same held-push-to-talk reason: a
    // sync pull hands over a freshly parsed (new-ref) copy of an unchanged chord.
    // reregister runs after the save resolves, so the Rust side reads the just-persisted
    // config (no race).
    if (
      (state.profiles !== prev.profiles && bindingSig(state.profiles) !== bindingSig(prev.profiles)) ||
      state.settings.general.evdevEnabled !== prev.settings.general.evdevEnabled ||
      (state.settings.general.quickAddHotkey !== prev.settings.general.quickAddHotkey &&
        JSON.stringify(state.settings.general.quickAddHotkey) !==
          JSON.stringify(prev.settings.general.quickAddHotkey)) ||
      (state.settings.quickAddList == null) !== (prev.settings.quickAddList == null)
    ) {
      pendingBindingChange = true;
    }
    // Toggling evdev can change whether it's PERMITTED — refresh so the save-gate's collapse decision
    // tracks the live backend (the toggle alone doesn't carry the permitted bit).
    if (state.settings.general.evdevEnabled !== prev.settings.general.evdevEnabled) {
      void evdevStatus()
        .then((st) => {
          evdevPermitted = st.permitted;
        })
        .catch(() => {});
    }
    clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), 400);
  });

  // The debounced save itself. Resolves when the write settled (never rejects: both outcomes are
  // handled below), or at once when the conflict freeze holds it back.
  function saveNow(): Promise<void> {
    timer = undefined;
    const s = useApp.getState();
    // Don't persist or register a conflicting binding set — the last good config stays live
    // until the user resolves it. Surface the freeze GLOBALLY via the save banner: otherwise
    // it's silent and unrelated settings/backends edits are dropped, with only the Profiles
    // screen hinting why. Keep pendingBindingChange so the fix triggers a reregister.
    // Include the quick-add chord as a synthetic peer (mirrors the capture-time check in
    // Profiles.tsx / the Dictionary screen's QuickAddShortcutField (was the Settings quick-add row)). It shares the same chord namespace as profile
    // chords in every hotkey backend (evdev / Windows hook / plugin each keep the first in config
    // order and drop the later duplicate), but the enable toggle bypasses capture — so an enabled profile could silently collide with quick-add
    // unless the save-gate sees it too.
    const qa = s.settings.general.quickAddHotkey;
    const conflictPeers = withQuickAddPeer(s.profiles, qa);
    // No low-level backend (Linux with evdev off OR enabled-but-not-permitted) ⇒ the plugin
    // registers and can't tell modifier sides apart, so collapse L/R for conflict detection (else
    // two side-only-different chords pass here yet one silently never registers). Mirrors Rust's
    // apply_bindings branch and the capture-time + per-card checks. On Windows the hook backend
    // always distinguishes sides — never collapse.
    if (conflicts(conflictPeers, !IS_WINDOWS && !(s.settings.general.evdevEnabled && evdevPermitted)).length > 0) {
      useApp
        .getState()
        .setSaveError("A shortcut is used by two bindings — resolve the conflict to resume saving.");
      return Promise.resolve();
    }
    const reReg = pendingBindingChange;
    pendingBindingChange = false;
    const saving = saveConfig({ settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules, version: CONFIG_VERSION })
      .then(
        () => {
          // The write landed — clear any prior save-failure banner, THEN re-register. A "load"
          // notice (settings reset from a corrupt file / failed to load) is not a save failure:
          // it stays until the user dismisses it — and comes back once a save error or conflict
          // freeze that replaced it clears — so an edit can't silently erase where the backup
          // went or the "saving may overwrite" warning. Re-registration has its OWN
          // catch: a reregister failure is NOT data loss (the config was persisted fine), so it
          // must never raise the "couldn't save your settings" banner below.
          if (loadNotice) {
            if (useApp.getState().saveError !== loadNotice) useApp.getState().setSaveError(loadNotice, "load");
          } else useApp.getState().setSaveError(null);
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
    inFlight = saving;
    void saving.then(() => {
      if (inFlight === saving) inFlight = null;
    });
    return saving;
  }

  flushPendingSave = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      return saveNow();
    }
    return inFlight ?? Promise.resolve();
  };

  useApp.getState().setConfigLoaded();
  resolveConfigReady();
}
