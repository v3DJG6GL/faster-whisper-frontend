import { useEffect, type DependencyList } from "react";
import { AlertTriangle, X } from "lucide-react";
import { HashRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useApp } from "@/lib/store";
import { initConfig } from "@/lib/persistence";
import { initOverlayController } from "@/lib/overlay";
import { initUsageController } from "@/lib/usage";
import { onTrigger, onSystemResumed, onOverlayAction, onAppNavigate } from "@/lib/api";
import { dictate, runOverlayAction } from "@/lib/dictation";
import { cancelLive, requestStopIfStarting } from "@/lib/streaming";
import { SCREEN_PATH } from "@/lib/screens";
import Home from "@/screens/Home";
import Transcribe from "@/screens/Transcribe";
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
    void subscribe().then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
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
        if (path) navigate(path);
      }),
    [navigate],
  );
  return null;
}

// Surfaces a config auto-save failure (disk full / read-only / IPC) OR a refused save (two
// profiles share a shortcut, so the conflicting set is held back). The app otherwise saves
// settings/backends/profiles silently (debounced), so without this a non-write is invisible
// and the user's changes vanish on the next launch. Both self-heal — the next successful save
// clears the banner. Dismissible.
function SaveErrorBanner() {
  const saveError = useApp((s) => s.saveError);
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
          <span className="font-semibold">Couldn’t save your settings.</span> Recent changes may be
          lost when you restart the app. <span className="text-warn/80">{saveError}</span>
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

export default function App() {
  const theme = useApp((s) => s.settings.theme);

  useEffect(() => {
    void initConfig();
    void initOverlayController();
    initUsageController();
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
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <HashRouter>
      <NavigationBridge />
      <div className="relative z-10 flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/transcribe" element={<Transcribe />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/backends" element={<Backends />} />
            <Route path="/dictionary" element={<Dictionary />} />
            <Route path="/app-rules" element={<AppRules />} />
            <Route path="/statistics" element={<Statistics />} />
            {/* legacy path → Backends (renamed from "Servers"/models) */}
            <Route path="/models" element={<Navigate to="/backends" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <SaveErrorBanner />
    </HashRouter>
  );
}
