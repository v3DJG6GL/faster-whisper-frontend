// Single source of truth for the app's navigable screens and the dictation
// actions the overlay can trigger. Keep each `path` in sync with the <Route>s in App.tsx.

import { LayoutDashboard, AudioLines, Command, Server, Settings, Power, RefreshCw, AppWindow, BookA, BarChart3, Plus, History, ScrollText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { OverlayScreen, OverlayActionKind, OverlayQuickAction } from "./types";
import { IS_LINUX, IS_WINDOWS } from "./platform";

export interface ScreenDef {
  id: OverlayScreen;
  label: string;
  path: string; // router path (HashRouter)
  icon: LucideIcon;
  end?: boolean; // exact-match the index route
  /** Backed by the focused-app detector (AT-SPI on Linux, focus::windows on Windows)
   *  — hidden on platforms without one. */
  needsFocusDetection?: boolean;
}

export const SCREENS: ScreenDef[] = [
  { id: "dashboard", label: "Dashboard", path: "/", icon: LayoutDashboard, end: true },
  { id: "statistics", label: "Statistics", path: "/statistics", icon: BarChart3 },
  { id: "transcribe", label: "Transcribe", path: "/transcribe", icon: AudioLines },
  { id: "history", label: "History", path: "/history", icon: History },
  { id: "profiles", label: "Profiles", path: "/profiles", icon: Command },
  { id: "backends", label: "Backends", path: "/backends", icon: Server },
  { id: "dictionary", label: "Dictionary", path: "/dictionary", icon: BookA },
  { id: "app-rules", label: "App rules", path: "/app-rules", icon: AppWindow, needsFocusDetection: true },
  // Sidebar visibility is additionally gated by the live "Show Logs in the
  // sidebar" setting (Sidebar.tsx) — a live toggle can't use the static
  // VISIBLE_SCREENS filter. The route stays registered regardless.
  { id: "logs", label: "Logs", path: "/logs", icon: ScrollText },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings },
];

/** Screens to offer in navigation / pickers on THIS platform. Lookups (paths,
 *  quick-launch labels for entries saved on another OS) keep using SCREENS. */
export const VISIBLE_SCREENS: ScreenDef[] = SCREENS.filter(
  (s) => !s.needsFocusDetection || IS_LINUX || IS_WINDOWS,
);

/** The product name the page eyebrows carry. */
export const APP_NAME = "faster-whisper-frontend";

/** A screen's title is its sidebar label — the one name a screen has everywhere. */
export function screenTitle(id: OverlayScreen): string {
  return SCREENS.find((s) => s.id === id)?.label ?? id;
}

/** The eyebrow above a page title: "faster-whisper-frontend · Dashboard". */
export function screenEyebrow(id: OverlayScreen): string {
  return `${APP_NAME} · ${screenTitle(id)}`;
}

/** Screen id → router path, for the navigate bridge. */
export const SCREEN_PATH = Object.fromEntries(SCREENS.map((s) => [s.id, s.path])) as Record<
  OverlayScreen,
  string
>;

export interface OverlayActionDef {
  id: OverlayActionKind;
  label: string;
  icon: LucideIcon;
}

export const OVERLAY_ACTIONS: OverlayActionDef[] = [
  { id: "toggle-dictation", label: "Toggle dictation", icon: Power },
  { id: "cycle-active-profile", label: "Cycle profile", icon: RefreshCw },
  { id: "open-quick-add", label: "Quick add", icon: Plus },
];

/** Label + icon for a quick-launch entry, resolved from the registries above. `known` is false
 *  when the target is in neither registry (a synced / newer-version entry): callers must not
 *  dispatch it — the raw target could name an internal action kind the button never showed. */
export function quickLaunchMeta(e: OverlayQuickAction): { label: string; icon: LucideIcon; known: boolean } {
  const reg =
    e.kind === "screen"
      ? SCREENS.find((s) => s.id === e.target)
      : OVERLAY_ACTIONS.find((a) => a.id === e.target);
  // No raw-target fallback: the lookup matches the RAW target, so a zero-width-padded target
  // like "settings\u200b" resolves to nothing, and showing the raw target would render an
  // inert button impersonating a real one.
  return {
    label: reg?.label ?? "Unknown action",
    icon: reg?.icon ?? SCREENS[0].icon,
    known: !!reg,
  };
}
