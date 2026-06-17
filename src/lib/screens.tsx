// Single source of truth for the app's navigable screens and the dictation
// actions the overlay can trigger. Consumed by the Sidebar, the overlay chip's
// quick-launch row, the Settings quick-launch editor, and the cross-window
// navigation bridge (App.tsx). Keep `id`s in sync with the router paths in App.tsx.

import { Home, AudioLines, Command, Server, Settings, Power, RefreshCw, AppWindow, BookA, BarChart3, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { OverlayScreen, OverlayActionKind, OverlayQuickAction } from "./types";

export interface ScreenDef {
  id: OverlayScreen;
  label: string;
  path: string; // router path (HashRouter)
  icon: LucideIcon;
  end?: boolean; // exact-match the index route
}

export const SCREENS: ScreenDef[] = [
  { id: "home", label: "Home", path: "/", icon: Home, end: true },
  { id: "transcribe", label: "Transcribe", path: "/transcribe", icon: AudioLines },
  { id: "profiles", label: "Profiles", path: "/profiles", icon: Command },
  { id: "backends", label: "Backends", path: "/backends", icon: Server },
  { id: "dictionary", label: "Dictionary", path: "/dictionary", icon: BookA },
  { id: "app-rules", label: "App rules", path: "/app-rules", icon: AppWindow },
  { id: "statistics", label: "Statistics", path: "/statistics", icon: BarChart3 },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings },
];

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

/** Label + icon for a quick-launch entry, resolved from the registries above. */
export function quickLaunchMeta(e: OverlayQuickAction): { label: string; icon: LucideIcon } {
  const reg =
    e.kind === "screen"
      ? SCREENS.find((s) => s.id === e.target)
      : OVERLAY_ACTIONS.find((a) => a.id === e.target);
  return { label: reg?.label ?? e.target, icon: reg?.icon ?? SCREENS[0].icon };
}
