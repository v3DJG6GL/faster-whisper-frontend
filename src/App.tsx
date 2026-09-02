import { useEffect, useState, type DependencyList, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useApp } from "@/lib/store";
import { initConfig } from "@/lib/persistence";
import { initSync } from "@/lib/sync";
import { initOverlayController } from "@/lib/overlay";
import { initUsageController } from "@/lib/usage";
import { onTrigger, onSystemResumed, onOverlayAction, onAppNavigate } from "@/lib/api";
import { dictate, runOverlayAction } from "@/lib/dictation";
import { cancelLive, requestStopIfStarting } from "@/lib/streaming";
import { SCREEN_PATH } from "@/lib/screens";
import { applyAccentAndTheme, startAccentDrift, watchSystemTheme } from "@/lib/theme";
import { initLogStatus, openLogsPrefiltered } from "@/lib/logs";
import { flushRecordWrites } from "@/lib/transcriptHistory";
import { tryNavigate } from "@/lib/navGuard";
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

// Subscribe to a Tauri event for the component's lifetime via the StrictMode-safe cancelled-guard.
// React StrictMode (dev) mounts → unmounts → remounts and runs the cleanup BEFORE the listen()
// promise resolves; without the guard the first listener is never removed and a second is added, so
// every event fires its handler twice (double sound + duplicate sessions). `subscribe` returns the
// unlisten fn; re-subscribes when `deps` change. (deps drive the effect; `subscribe` is recreated
// each render so it's intentionally excluded.)
function useTauriListener(subscribe: () => Promise<() => void>, deps: DependencyList) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void subscribe()
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {}); // a rejected dynamic import / listen() must not surface as an unhandled rejection
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Each page opens at its top: <main> is one persistent scroll container, so
// without this a route change kept whatever scroll offset the previous page
// left ("History opened mid-list"). History is exempt — it restores its own
// remembered position instead.
function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname === "/history") return;
    document.querySelector("main")?.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Bridges overlay → main-window navigation: the chip calls show_main_at_screen, which
// focuses this window and emits `app://navigate`; here (inside the router) we turn
// that into a route change. Must live within <HashRouter> to use useNavigate.
function NavigationBridge() {
  const navigate = useNavigate();
  useTauriListener(
    () =>
      onAppNavigate((screen) => {
        const path = SCREEN_PATH[screen as keyof typeof SCREEN_PATH];
        // Same unsaved-work guard the sidebar runs: the overlay chip can fire
        // this while a list editor is open.
        if (path) {
          const go = () => navigate(path);
          if (tryNavigate(go)) go();
        }
      }),
    [navigate],
  );
  return null;
}

// Surfaces a config auto-save failure (disk full / read-only / IPC) OR a refused save (two
// profiles share a shortcut, so the conflicting set is held back) — kind "save". Also carries the
// startup load-time notices (config reset from a corrupt file, or a failed load) — kind "load" —
// which are self-contained and must NOT wear the save-failure framing (they'd read as a lie: nothing
// failed to save). The app otherwise saves settings/backends/profiles silently (debounced), so
// without this a non-write is invisible. Self-heals — the next successful save clears it. Dismissible.
function SaveErrorBanner() {
  const saveError = useApp((s) => s.saveError);
  const saveErrorKind = useApp((s) => s.saveErrorKind);
  const setSaveError = useApp((s) => s.setSaveError);
  if (!saveError) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
      <div
        role="alert"
        className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-warn shadow-lg backdrop-blur-sm"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1">
          {saveErrorKind === "load" ? (
            // Load-time notice — self-contained; no "Couldn't save / changes lost on restart" framing.
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
    </div>
  );
}

// The failure doorway: "Transcription failed — View logs". Set by the dictation
// and batch-transcription error paths; "View logs" lands on /logs pre-filtered
// to warnings+errors. Same bottom-center slot as SaveErrorBanner (renders above
// it when both are up, since it sits earlier in the flex column). Must live
// inside <HashRouter> for useNavigate.
function LogsDoorwayBanner() {
  const doorway = useApp((s) => s.logsDoorway);
  const setLogsDoorway = useApp((s) => s.setLogsDoorway);
  const navigate = useNavigate();
  if (!doorway) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-14 z-50 flex justify-center px-4 pb-4">
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
                navigate("/logs");
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
    </div>
  );
}

export default function App() {
  const theme = useApp((s) => s.settings.theme);
  const accentHue = useApp((s) => s.settings.accentHue);
  const accentMotion = useApp((s) => s.settings.accentMotion);
  // First-run gate: a LOADED config with no backends AND no profiles (fresh
  // install — seeds are gone) and no prior skip mounts the onboarding flow
  // instead of the shell. Latched locally so the flow survives its own store
  // writes (creating Backend #1 makes backends non-empty mid-flow); it closes
  // only via onDone, and setupDismissed keeps it from ever re-opening.
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
    // Sidebar Logs badge: always-on counter feed (tiny, change-gated events).
    initLogStatus();
    // History coalesces rapid record writes (chunked translate); land them on quit/reload.
    window.addEventListener("beforeunload", flushRecordWrites);
    return () => window.removeEventListener("beforeunload", flushRecordWrites);
  }, []);

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
        // A live session's mic/WS is dead after resume → reset it. A session still mid-START
        // (status not yet "listening") reads "idle", so cancelLive wouldn't catch it; mark it to
        // tear down on go-live instead, else its prologue completes against the dead mic and wedges.
        if (useApp.getState().status !== "idle") void cancelLive();
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
        <SaveErrorBanner />
      </>
    );
  }

  return (
    <HashRouter>
      <NavigationBridge />
      <ScrollReset />
      <div className="relative z-10 flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transcribe" element={<Transcribe />} />
            <Route path="/history" element={<HistoryScreen />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/backends" element={<Backends />} />
            <Route path="/dictionary" element={<Dictionary />} />
            <Route path="/app-rules" element={<AppRules />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/logs" element={<Logs />} />
            {/* legacy path → Backends (renamed from "Servers"/models) */}
            <Route path="/models" element={<Navigate to="/backends" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <LogsDoorwayBanner />
      <SaveErrorBanner />
    </HashRouter>
  );
}
