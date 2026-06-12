import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useApp } from "@/lib/store";
import { initConfig } from "@/lib/persistence";
import Home from "@/screens/Home";
import Transcribe from "@/screens/Transcribe";
import SpeechModels from "@/screens/SpeechModels";
import Settings from "@/screens/Settings";

export default function App() {
  const theme = useApp((s) => s.settings.theme);

  useEffect(() => {
    void initConfig();
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
            <Route path="/models" element={<SpeechModels />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
