import { useEffect, useLayoutEffect, useState, type ReactNode, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useApp } from "@/lib/store";
import { flushConfigSave, initConfig } from "@/lib/persistence";
import { migrateLegacyMicPin } from "@/lib/micMigration";
import { initSync } from "@/lib/sync/sync";
import { initOverlayController } from "@/lib/dictation/chipController";
import { initUsageController } from "@/lib/usage";
import { initCapsController } from "@/lib/capabilities";
import { initJobReconcile } from "@/lib/jobsReconcile";
import {
  noteRoute, onTrigger, onSystemResumed, onOverlayAction, onAppNavigate, onBeforeQuit, onSessionEnding, quitReady,
} from "@/lib/api";
import { dictate, runOverlayAction } from "@/lib/dictation/dictation";
import { cancelLive, requestStopIfStarting } from "@/lib/dictation/streaming";
import { SCREEN_PATH } from "@/lib/screenRegistry";
import { applyAccentAndTheme, startAccentDrift, watchSystemTheme } from "@/lib/theme";
import { initLogStatus, openLogsPrefiltered } from "@/lib/logViewer";
import { flushRecordWrites, listenRetentionSweeps } from "@/lib/transcript/transcriptHistory";
import { flushPersistEdits } from "@/lib/transcribeRun";
import { flushOutcomeSave } from "@/lib/usageOutcome";
import { tryNavigate } from "@/lib/navGuard";
import { useTauriListener } from "@/lib/useTauriListener";
import { Onboarding } from "@/screens/Onboarding";
import Logs from "@/screens/Logs";
import Dashboard from "@/screens/Dashboard";
import Transcribe from "@/screens/Transcribe";
import HistoryScreen from "@/screens/History";
import Profiles from "@/screens/Profiles";
import Backends from "@/screens/Backends";
import Dictionary from "@/screens/Dictionary";
import AppRules from "@/screens/AppRules";
import Statistics from "@/screens/Statistics";
import Settings from "@/screens/Settings";

// Land every debounced / coalesced write. History edits go first: they feed the record writes.
// None of the flushes rejects.
function flushPendingWrites(): Promise<PromiseSettledResult<void>[]> {
  flushPersistEdits();
  return Promise.allSettled([flushRecordWrites(), flushConfigSave(), flushOutcomeSave()]);
}

// Each page opens at its top: <main> is one persistent scroll container that would
// otherwise keep the previous page's offset. History is exempt — it restores its own
// remembered position instead.
function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    noteRoute(pathname);
    if (pathname === SCREEN_PATH.history) return;
    document.querySelector("main")?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Bridges navigation requests from outside the main window (the chip's quick-launch,
// Quick-Add, the tray menu): show_main_at_screen focuses this window and emits
// `app://navigate`; here (inside the router) we turn that into a route change. Must live
// within <HashRouter> to use useNavigate.
function NavigationBridge() {
  const navigate = useNavigate();
  // navigate changes identity on every route change under HashRouter (useNavigateUnstable
  // deps include the pathname); subscribing once with a ref keeps the app://navigate
  // listener registered for the router's lifetime instead of re-issuing listen() per
  // navigation and opening a drop window.
  const navRef = useRef(navigate);
  navRef.current = navigate;
  // Same ref idiom for the current path: a request for the screen already shown skips the
  // guard (navigating to the same path keeps a dirty editor open, so "Discard" would lie).
  // The window itself is still shown/focused by show_main_at_screen on the Rust side.
  const { pathname } = useLocation();
  const locRef = useRef(pathname);
  locRef.current = pathname;
  useTauriListener(
    () =>
      onAppNavigate((screen) => {
        // Own-key lookup: the target comes from a synced quick-launch setting that is only
        // type-checked, so "constructor" must not resolve to an Object.prototype member.
        const path = Object.prototype.hasOwnProperty.call(SCREEN_PATH, screen)
          ? SCREEN_PATH[screen as keyof typeof SCREEN_PATH]
          : undefined;
        // Same unsaved-work guard the sidebar runs: the overlay chip can fire
        // this while a list editor is open.
        if (path && path !== locRef.current) {
          const go = () => navRef.current(path);
          if (tryNavigate(go)) go();
        }
      }),
    [],
  );
  return null;
}

// The unsaved-work guard for history traversal: a mouse back/forward button, Alt+Left/Right or a
// swipe makes the webview walk the HashRouter history the app's own navigations pushed, which no
// issued-navigation guard sees — the editor would unmount with its draft and no prompt.
//
// popstate is the authoritative layer. The router reacts to it with its own (bubble) listener, and
// React commits that discrete update in the microtask checkpoint right after the listener returns,
// so the editor would be gone before any later listener ran. This one therefore runs FIRST: capture
// phase (at-target capture listeners run before bubble ones) and registered in a layout effect of
// a router child (child layout effects run before HashRouter's own listen()), so either ordering
// rule puts it ahead. On a refused traversal it re-pushes the editor's location, synchronously,
// before the router reads `window.location`: the router then sees the editor's location popped
// (delta 0), the route never changes and the editor never unmounts. (The re-push drops the forward
// entry the user just left, which the app has no affordance for anyway.)
//
// The guard's "Discard" / "Save and leave" then STEPS BACK onto the popped entry instead of pushing
// it again: the re-push was made from that entry, so it always sits right before the re-pushed
// editor copy — `go(-1)` for a refused Back and a refused Forward alike — and the stack keeps the
// shape a plain traversal would have left (a push would stack the target on top, and the next Back
// would land on the editor's screen again). That pop arrives while the draft is still dirty (leave()
// does not clean it before the unmount), so it is let through once by `bypassPopTo`.
//
// Every traversal source — the mouse back/forward buttons and the Browser Back/Forward keys
// included — goes through this one popstate layer, so each of them refuses, restores and asks
// alike. (Cancelling those presses at mouseup/keydown instead dropped them with no prompt at all.)
let bypassPopTo: string | null = null;

function HistoryTraversalGuard() {
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  // The location the router is showing (still the pre-traversal one when popstate fires), spelled
  // like the hash it was parsed from.
  const { pathname, search, hash } = useLocation();
  const lastRef = useRef(pathname + search + hash);
  lastRef.current = pathname + search + hash;
  useLayoutEffect(() => {
    const onPop = () => {
      const target = window.location.hash.replace(/^#/, "") || "/";
      const last = lastRef.current;
      // The step back a "Discard" / "Save and leave" asked for: let it through without asking
      // again. Matched on the target so a step that never popped can't wave a later one through.
      const bypass = bypassPopTo;
      bypassPopTo = null;
      if (bypass !== null && bypass === target) return;
      // Same location (forward onto the re-pushed copy): nothing unmounts, nothing to ask.
      if (target === last) return;
      const proceed = () => {
        bypassPopTo = target;
        window.history.go(-1);
      };
      if (tryNavigate(proceed)) return;
      navRef.current(last);
    };
    window.addEventListener("popstate", onPop, true);
    return () => window.removeEventListener("popstate", onPop, true);
  }, []);
  return null;
}

// Surfaces a config auto-save failure (disk full / read-only / IPC) or a refused save (two
// bindings share a shortcut, so the conflicting set is held back) — kind "save", cleared by the
// next successful save. Also the startup load notices (config reset from a corrupt file, or a
// failed load) — kind "load", which must NOT wear the save-failure framing (nothing failed to
// save) and stays until dismissed. Saves are otherwise silent, so without this a non-write is
// invisible.
function SaveErrorBanner() {
  const saveError = useApp((s) => s.saveError);
  const saveErrorKind = useApp((s) => s.saveErrorKind);
  const setSaveError = useApp((s) => s.setSaveError);
  if (!saveError) return null;
  return (
    <div
      role="alert"
      className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-warn shadow-lg backdrop-blur-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        {saveErrorKind === "load" ? (
          saveError
        ) : (
          <>
            <span className="font-semibold">Couldn’t save your settings.</span> Recent changes may
            be lost when you restart the app. <span className="text-warn/80">{saveError}</span>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => setSaveError(null)}
        title="Dismiss"
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-0.5 text-warn/70 hover:text-warn"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// The failure doorway: "Transcription failed — View logs". Set by the dictation
// and batch-transcription error paths; "View logs" lands on /logs pre-filtered
// to warnings+errors. Must live inside <HashRouter> for useNavigate.
function LogsDoorwayBanner() {
  const doorway = useApp((s) => s.logsDoorway);
  const setLogsDoorway = useApp((s) => s.setLogsDoorway);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  if (!doorway) return null;
  return (
    <div
      role="alert"
      className="pointer-events-auto flex max-w-xl items-center gap-2.5 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-warn shadow-lg backdrop-blur-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{doorway.msg}</span>
      {/* Only when the log actually holds MORE than the message says —
          the truthful-toast contract (errors.ts sets showLogs). */}
      {doorway.showLogs && (
        <button
          type="button"
          // Through the unsaved-work guard like every other navigation the shell issues: the
          // doorway is raised asynchronously and can land over an open editor.
          onClick={() => {
            const go = () => {
              setLogsDoorway(null);
              openLogsPrefiltered("warn");
              // Already on Logs (the prefilter applies in place): skip the push like the sidebar
              // and the overlay bridge do, or a duplicate /logs entry makes the next Back a no-op.
              if (pathname !== SCREEN_PATH.logs) navigate(SCREEN_PATH.logs);
            };
            if (tryNavigate(go)) go();
          }}
          className="shrink-0 whitespace-nowrap font-semibold text-accent hover:underline"
        >
          View logs
        </button>
      )}
      <button
        type="button"
        onClick={() => setLogsDoorway(null)}
        title="Dismiss"
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-0.5 text-warn/70 hover:text-warn"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// The fixed bottom-center slot the shell's banners share: one flex column, so they stack
// at their real heights instead of each guessing the other's offset.
function BottomBanners({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-4">
      {children}
    </div>
  );
}

export default function App() {
  const theme = useApp((s) => s.settings.theme);
  const accentHue = useApp((s) => s.settings.accentHue);
  const accentMotion = useApp((s) => s.settings.accentMotion);
  // First-run gate (a fresh install seeds no backends or profiles). Latched locally so the flow
  // survives its own store writes (creating Backend #1 makes backends non-empty mid-flow); it
  // closes only via onDone, and setupDismissed keeps it from ever re-opening.
  const configLoaded = useApp((s) => s.configLoaded);
  // Not on a FAILED load: the store is then the empty boot state, not an empty config, and
  // every exit from onboarding ("Skip for now" included) writes the store — which the armed
  // auto-save would persist over the real config. The load-failure banner says what happened.
  const needsSetup = useApp(
    (s) =>
      !s.configLoadFailed && s.backends.length === 0 && s.profiles.length === 0 && !s.settings.setupDismissed,
  );
  const [onboarding, setOnboarding] = useState(false);
  // Decided ONCE, on the state the config loaded with: a later wipe (last
  // backend deleted, a sync pull that lands an empty list) is the Home
  // checklist's case, not a mid-session full-screen gate over the running shell.
  const gateDecided = useRef(false);
  useEffect(() => {
    if (!configLoaded || gateDecided.current) return;
    gateDecided.current = true;
    if (needsSetup) setOnboarding(true);
  }, [configLoaded, needsSetup]);

  useEffect(() => {
    void initConfig();
    // Sync engine orders itself after the config load via the configReady
    // barrier (startup pull must merge against the real persisted state).
    void initSync();
    void initOverlayController();
    initUsageController();
    initCapsController();
    // Runs the app was quit in the middle of: re-attach to what the server still
    // holds (orders itself after the config load via configReady).
    void initJobReconcile();
    // A microphone saved by name moves to its device id (orders itself after configReady).
    void migrateLegacyMicPin();
    // Sidebar Logs badge: always-on counter feed (tiny, change-gated events).
    initLogStatus();
    // A retention sweep that removed History records reloads the History mirror.
    listenRetentionSweeps();
    // A reload lands the same writes as a quit. A real quit never fires beforeunload — that goes
    // through the `app://before-quit` handshake below.
    const onUnload = () => {
      void flushPendingWrites();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // Quit handshake (tray Quit / the trayless close): land every pending write, then let Rust
  // exit. Rust waits at most ~1.5 s for this, so a slow or failed save can't block quit.
  useTauriListener(
    () =>
      onBeforeQuit(() => {
        void (async () => {
          try {
            await flushPendingWrites();
          } finally {
            void quitReady().catch(() => {});
          }
        })();
      }),
    [],
  );

  // Windows session end (shutdown / logoff): Rust asks for the same writes early, on
  // WM_QUERYENDSESSION, without waiting for them. No quitReady here — the user may still cancel
  // the shutdown, and quit_ready latches the quit handshake as answered for good.
  useTauriListener(
    () =>
      onSessionEnding(() => {
        void flushPendingWrites();
      }),
    [],
  );

  // Global dictation triggers (CLI / hotkeys) → start/stop the right mode.
  useTauriListener(() => onTrigger((e) => dictate(e.profileId, e.action)), []);

  // Dictation actions requested from the overlay chip's quick-launch (a separate
  // window) arrive as `overlay://action` events — run them here.
  useTauriListener(() => onOverlayAction((kind) => runOverlayAction(kind)), []);

  // After the machine resumes from suspend, the mic/WebSocket of any in-flight
  // dictation is dead — reset it so the chip doesn't hang at "finalizing…". (Rust has
  // already rebuilt the hotkey backend by the time this fires.)
  useTauriListener(
    () =>
      onSystemResumed(() => {
        // A session still mid-START (status not yet "listening") reads "idle", so cancelLive
        // wouldn't catch it; mark it to tear down on go-live instead, else its prologue completes
        // against the dead mic and wedges.
        if (useApp.getState().status !== "idle") void cancelLive({ keepRecording: true });
        else requestStopIfStarting();
      }),
    [],
  );

  useEffect(() => {
    applyAccentAndTheme(accentHue, accentMotion, theme);
    // While on "auto", track live OS scheme flips (Windows app-mode / desktop setting).
    return watchSystemTheme(() => useApp.getState().settings.theme);
  }, [theme, accentHue, accentMotion]);
  // This window's drift clock (a no-op while Motion is Still); every window runs its own.
  useEffect(() => startAccentDrift(), []);

  if (onboarding) {
    return (
      <>
        <Onboarding onDone={() => setOnboarding(false)} />
        <BottomBanners>
          <SaveErrorBanner />
        </BottomBanners>
      </>
    );
  }

  // Navigations render synchronously: as a transition, a heavy page (Statistics) would be
  // starved for seconds by the Dashboard's ~30 Hz dictation level updates interrupting it.
  return (
    <HashRouter useTransitions={false}>
      <HistoryTraversalGuard />
      <NavigationBridge />
      <ScrollReset />
      <div className="relative z-10 flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path={SCREEN_PATH.dashboard} element={<Dashboard />} />
            <Route path={SCREEN_PATH.transcribe} element={<Transcribe />} />
            <Route path={SCREEN_PATH.history} element={<HistoryScreen />} />
            <Route path={SCREEN_PATH.profiles} element={<Profiles />} />
            <Route path={SCREEN_PATH.backends} element={<Backends />} />
            <Route path={SCREEN_PATH.dictionary} element={<Dictionary />} />
            <Route path={SCREEN_PATH["app-rules"]} element={<AppRules />} />
            <Route path={SCREEN_PATH.statistics} element={<Statistics />} />
            <Route path={SCREEN_PATH.logs} element={<Logs />} />
            {/* legacy path → Backends (renamed from "Servers"/models) */}
            <Route path="/models" element={<Navigate to={SCREEN_PATH.backends} replace />} />
            <Route path={SCREEN_PATH.settings} element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <BottomBanners>
        <LogsDoorwayBanner />
        <SaveErrorBanner />
      </BottomBanners>
    </HashRouter>
  );
}
