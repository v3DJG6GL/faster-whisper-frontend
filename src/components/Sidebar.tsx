import { NavLink } from "react-router-dom";
import { Home, AudioLines, Server, Settings as SettingsIcon, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApp } from "@/lib/store";
import { StatusDot } from "./ui";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/transcribe", label: "Transcribe", icon: AudioLines, end: false },
  { to: "/models", label: "Servers", icon: Server, end: false },
];

function BrandMark() {
  // A forward-leaning level meter — "signal in motion". Distinct amber identity.
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
      <rect width="26" height="26" rx="7" fill="var(--c-accent)" fillOpacity="0.14" />
      <g fill="var(--c-accent)">
        <rect x="6" y="11" width="2.6" height="4" rx="1.3" transform="skewX(-8)" />
        <rect x="10" y="8" width="2.6" height="10" rx="1.3" transform="skewX(-8)" />
        <rect x="14" y="5.5" width="2.6" height="15" rx="1.3" transform="skewX(-8)" />
        <rect x="18" y="9.5" width="2.6" height="7" rx="1.3" transform="skewX(-8)" />
      </g>
    </svg>
  );
}

export function Sidebar() {
  const theme = useApp((s) => s.settings.theme);
  const setTheme = useApp((s) => s.setTheme);
  const status = useApp((s) => s.status);

  return (
    <aside className="relative z-10 flex w-[228px] shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="flex items-center gap-2.5 px-5 pb-5 pt-6">
        <BrandMark />
        <div className="leading-none">
          <div className="font-display text-[15px] font-semibold tracking-tight text-text">
            faster<span className="text-accent">whisper</span>
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-label text-faint">
            dictation
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-colors",
                isActive ? "bg-surface-2 text-text" : "text-dim hover:bg-surface/60 hover:text-text",
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  className={cn("size-[18px] transition-colors", isActive ? "text-accent" : "text-faint group-hover:text-dim")}
                  strokeWidth={2}
                />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto px-3 pb-4">
        <div className="mb-2 flex items-center gap-2 px-3 py-2 text-[12px] text-dim">
          <StatusDot tone={status === "idle" ? "ok" : status === "error" ? "warn" : "rec"} pulse={status !== "idle"} />
          <span className="font-mono text-[11px]">
            {status === "idle" ? "ready" : status}
          </span>
        </div>

        <div className="flex items-center gap-1 border-t border-line pt-3">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-colors",
                isActive ? "bg-surface-2 text-text" : "text-dim hover:bg-surface/60 hover:text-text",
              )
            }
          >
            <SettingsIcon className="size-[18px] text-faint" strokeWidth={2} />
            Settings
          </NavLink>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
            className="ring-signal grid size-9 place-items-center rounded-xl text-dim hover:bg-surface-2 hover:text-text"
          >
            {theme === "dark" ? <Sun className="size-[17px]" /> : <Moon className="size-[17px]" />}
          </button>
        </div>
      </div>
    </aside>
  );
}
