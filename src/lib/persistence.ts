import { useApp, CONFIG_VERSION } from "./store";
import { isTauri, loadConfig, saveConfig, applyLiveSwitches, reregisterShortcutsUnlessCapturing, evdevStatus } from "./api";
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
 *  the next successful save puts it back. Dismissing the load notice itself forgets it;
 *  dismissing a save-failure or conflict banner shown over it keeps it remembered. */
let loadNotice: string | null = null;

/** The last save was held back (hotkey-conflict freeze) or failed to write: config.json lacks
 *  what the store shows until a later save lands. Unlike the save banner, which the user can
 *  dismiss, this only clears on a successful save. */
let saveHeld = false;
/** The latest save attempt (a conflict freeze included): saves are not serialized, so only the
 *  newest attempt's outcome may set `saveHeld` — an earlier write settling late must not clear it
 *  over a later freeze, nor set it over a later write that landed. */
let saveSeq = 0;

/** Whether config.json is behind the store (see `saveHeld`): the sync push gate reads this, as
 *  sync ships what config.json holds, not a maybe. */
export function configSaveHeld(): boolean {
  return saveHeld;
}

/** Whether the evdev backend is actually PERMITTED. evdev is the live hotkey backend only when
 *  enabled AND permitted; otherwise the plugin is live and collapses L/R modifier sides, so the
 *  save gate in initConfig must mirror Rust's !(enabled && permitted) collapse decision. `null`
 *  until `evdevStatus` answers (and after it failed); refreshed at load and on the evdev toggle.
 *  How "unknown" reads depends on who asks — see `evdevPermittedFor`. */
let evdevPermitted: boolean | null = null;

/** The permitted bit as `use` must read it while it is unknown. The SAVE gate collapses until
 *  known (not permitted): a collapse there only holds a save, and a real side-only conflict is
 *  never missed. A sync APPLY / import preview treats unknown as permitted: a collapse there
 *  switches the later of a working LCtrl / RCtrl profile pair OFF, and that is saved and pushed
 *  to every device — while the save gate's own check still holds a genuine conflict. */
export function evdevPermittedFor(use: "save" | "apply"): boolean {
  return evdevPermitted ?? use === "apply";
}

/** The permitted bit for a sync apply or import preview deciding side-collapse (see `evdevPermittedFor`). */
export function evdevPermittedNow(): boolean {
  return evdevPermittedFor("apply");
}

/** How long startup waits for `evdevStatus` before `configReady` resolves without it: a hung IPC
 *  must not hold the sync engine off for good (unknown then reads as above). */
const EVDEV_STATUS_WAIT_MS = 2_000;

/** Set once initConfig has armed the auto-save: lands the debounced save now. */
let flushPendingSave: (() => Promise<void>) | null = null;

/** Land the debounced config save now (the quit handshake / session end): a pending 400 ms
 *  timer runs at once, else an in-flight save is awaited, and a held save (failed write) is
 *  retried once — a disk that recovered with no edit since still gets the store written. A
 *  conflict freeze stays frozen (the retry re-raises its banner, nothing is written). Never
 *  rejects — a failed save keeps its banner. Resolves at once outside Tauri and before
 *  initConfig armed the auto-save. */
export function flushConfigSave(): Promise<void> {
  return flushPendingSave ? flushPendingSave() : Promise.resolve();
}

/** Retry a held save now (see `saveHeld`) — the sync engine's manual Push, which otherwise has
 *  nothing to re-issue it but an unrelated edit. A pending or in-flight save decides the hold
 *  instead; nothing held, nothing to do. Never rejects. */
export function retryHeldConfigSave(): Promise<void> {
  return saveHeld ? flushConfigSave() : Promise.resolve();
}

/** Told when a successful save lifts a hold — the sync engine re-arms a push its gate refused
 *  meanwhile (a pull-apply's save clears a hold without any store edit the engine would see).
 *  One slot: persistence must not import the engine (it imports this module). */
let holdClearedListener: (() => void) | null = null;
export function onConfigSaveHoldCleared(cb: (() => void) | null): void {
  holdClearedListener = cb;
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

  // An answer that flips the save gate's collapse decision re-checks a save held under the old
  // one: a status slower than the startup cap (or the 400 ms save after an evdev toggle) froze an
  // L/R-only profile pair as "used by two bindings", and nothing else re-ran it — the banner, the
  // stale config.json and the refused sync push stayed until an unrelated edit. A real conflict
  // just holds again.
  const learnEvdevPermitted = (permitted: boolean) => {
    const before = evdevPermittedFor("save");
    evdevPermitted = permitted;
    if (saveHeld && evdevPermittedFor("save") !== before) void flushPendingSave?.();
  };

  // evdevPermitted (module scope, see there): read now, refreshed on the evdev toggle below.
  // configReady waits for it (bounded) below, so the startup pull decides side-collapse on the
  // real bit rather than on "unknown".
  const evdevKnown = evdevStatus()
    .then((st) => learnEvdevPermitted(st.permitted))
    .catch(() => {});

  // The load notice's banner went away (the user dismissed it; the save path below never clears
  // it while a load notice is remembered — it restores it instead) ⇒ forget the load notice.
  // Dismissing a save failure or a conflict freeze that took the slot does not: the next
  // successful save puts the load notice back.
  useApp.subscribe((state, prev) => {
    if (prev.saveError && !state.saveError && prev.saveErrorKind === "load") loadNotice = null;
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
        .then((st) => learnEvdevPermitted(st.permitted))
        .catch(() => {});
    }
    clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), 400);
  });

  // The debounced save itself. Resolves when the write settled (never rejects: both outcomes are
  // handled below), or at once when the conflict freeze holds it back.
  function saveNow(): Promise<void> {
    timer = undefined;
    const mySeq = ++saveSeq;
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
    if (
      conflicts(conflictPeers, !IS_WINDOWS && !(s.settings.general.evdevEnabled && evdevPermittedFor("save"))).length > 0
    ) {
      useApp
        .getState()
        .setSaveError("A shortcut is used by two bindings — resolve the conflict to resume saving.");
      // The held save still hands Rust its live switches (Remote desktop rules, clipboard
      // privacy, log level): the paste path reads them per insert, so without this push-to-talk,
      // Quick-Add and clipboard writes would keep the frozen ones until the conflict is resolved
      // — and a switch to Debug would show in Settings while the log kept the old level.
      void applyLiveSwitches(
        s.appRules,
        s.settings.general.excludeFromClipboardHistory,
        // `logging` is optional on a config that predates it: Rust's default, as Settings shows.
        s.settings.logging?.logLevel ?? "info",
      ).catch(() => {});
      saveHeld = true; // the newest attempt, as `mySeq` is
      return Promise.resolve();
    }
    const reReg = pendingBindingChange;
    pendingBindingChange = false;
    const saving = saveConfig({ settings: s.settings, backends: s.backends, profiles: s.profiles, appRules: s.appRules, version: CONFIG_VERSION })
      .then(
        () => {
          // An earlier save settling after a later attempt neither clears that attempt's banner nor
          // its hold: the newest attempt decides both (see `saveSeq`).
          const newest = mySeq === saveSeq;
          if (newest && saveHeld) {
            saveHeld = false;
            try {
              holdClearedListener?.();
            } catch (e) {
              console.error("hold-cleared listener failed", e);
            }
          }
          // The write landed — clear any prior save-failure banner, THEN re-register. A "load"
          // notice (settings reset from a corrupt file / failed to load) is not a save failure:
          // it stays until the user dismisses it — and comes back once a save error or conflict
          // freeze that replaced it clears — so an edit can't silently erase where the backup
          // went or the "saving may overwrite" warning. Re-registration has its OWN
          // catch: a reregister failure is NOT data loss (the config was persisted fine), so it
          // must never raise the "couldn't save your settings" banner below.
          if (newest) {
            if (loadNotice) {
              if (useApp.getState().saveError !== loadNotice) useApp.getState().setSaveError(loadNotice, "load");
            } else useApp.getState().setSaveError(null);
          }
          // Use the capture-aware variant: a debounced save left pending by an edit just before the
          // user enters chord-capture can resolve DURING the capture window, and a plain reregister
          // would re-arm the hotkeys mid-capture (the next keypress would both rebind AND fire
          // dictation). When no capture is active it re-arms normally; the capture's own teardown
          // re-arms when it ends. Mirrors cancelLive's use of the same variant.
          // The newest write also carries a chord change whose own (older) save failed after this
          // one was issued: that failure handed the intent back too late for this save to take it.
          // The flag stays set — a chord changed after this save was issued needs its own save's
          // re-register; a second one is harmless.
          if (reReg || (newest && pendingBindingChange)) void reregisterShortcutsUnlessCapturing().catch((e) => console.error("reregister failed", e));
        },
        (e) => {
          // A real disk/IPC failure (full/read-only disk, perms) — the in-memory store still
          // shows the change, but it wasn't written, so warn the user it may be lost on restart.
          console.error("saveConfig failed", e);
          if (mySeq === saveSeq) {
            saveHeld = true;
            useApp.getState().setSaveError(e instanceof Error ? e.message : String(e));
          }
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
    if (inFlight) return inFlight;
    // A held save with nothing pending: retry it. A failed write may succeed now; a conflict
    // freeze returns at once from saveNow (its banner again, nothing written).
    return saveHeld ? saveNow() : Promise.resolve();
  };

  useApp.getState().setConfigLoaded();
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([evdevKnown, new Promise<void>((r) => (capTimer = setTimeout(r, EVDEV_STATUS_WAIT_MS)))]);
  clearTimeout(capTimer);
  resolveConfigReady();
}
