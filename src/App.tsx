import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useApp } from "@/lib/store";
import { initConfig } from "@/lib/persistence";
import { initOverlayController } from "@/lib/overlay";
import { onTrigger, onSystemResumed } from "@/lib/api";
import { dictate } from "@/lib/dictation";
import { cancelLive } from "@/lib/streaming";
import Home from "@/screens/Home";
import Transcribe from "@/screens/Transcribe";
import Profiles from "@/screens/Profiles";
import Backends from "@/screens/Backends";
import Settings from "@/screens/Settings";

export default function App() {
  const theme = useApp((s) => s.settings.theme);

  useEffect(() => {
    void initConfig();
    void initOverlayController();
  }, []);

  // Global dictation triggers (CLI / hotkeys) → start/stop the right mode.
  // The cancelled flag is essential: React StrictMode (dev) mounts → unmounts →
  // remounts, and the cleanup runs before `listen()` resolves. Without it the
  // first listener is never removed and a second is added, so every trigger
  // fires dictate() twice (double sound + duplicate backend sessions).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onTrigger((e) => dictate(e.profileId, e.action)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // After the machine resumes from suspend, the mic/WebSocket of any in-flight
  // dictation is dead — reset it so the chip doesn't hang at "finalizing…". (Rust has
  // already rebuilt the hotkey backend by the time this fires.)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onSystemResumed(() => {
      if (useApp.getState().status !== "idle") void cancelLive();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <HashRouter>
      <div className="relative z-10 flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/transcribe" element={<Transcribe />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/backends" element={<Backends />} />
            {/* legacy path → Backends (renamed from "Servers"/models) */}
            <Route path="/models" element={<Navigate to="/backends" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
