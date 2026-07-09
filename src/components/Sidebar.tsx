import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Settings as SettingsIcon, Moon, Sun, SunMoon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useApp } from "@/lib/store";
import { appVersion } from "@/lib/api";
import { VISIBLE_SCREENS } from "@/lib/screens";
import { PRIDE_FLAG_URI } from "@/lib/prideFlag";
import { dictationVisual } from "@/lib/dictationVisual";
import { StatusDot } from "./ui";

function BrandMark() {
  // The unified app mark — the same artwork as src-tauri/icons/icon.svg (five-bar
  // level meter on the warm-dark Signal tile); keep the two in sync. Colors are
  // fixed on purpose: it's the logo, identical in both themes and on the desktop.
  return (
    <svg width="26" height="26" viewBox="0 0 1024 1024" fill="none" aria-hidden>
      <defs>
        <linearGradient id="bm-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#262019" />
          <stop offset="1" stopColor="#0e0d0b" />
        </linearGradient>
        <linearGradient id="bm-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffb95e" />
          <stop offset="1" stopColor="#ff9e2c" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="url(#bm-tile)" />
      {/* Brand-family geometry: the five meter bars lean 9° forward, shared with the
          backend's mark ("whisper bars, faster lean"). Attribute transform (not CSS)
          so the same artwork rasterizes identically through `tauri icon`. */}
      <g fill="url(#bm-bar)" transform="translate(512 512) skewX(-9) translate(-512 -512)">
        <rect x="152" y="392" width="104" height="240" rx="52" />
        <rect x="308" y="292" width="104" height="440" rx="52" />
        <rect x="464" y="192" width="104" height="640" rx="52" />
        <rect x="620" y="332" width="104" height="360" rx="52" />
        <rect x="776" y="432" width="104" height="160" rx="52" />
      </g>
    </svg>
  );
}

export function Sidebar() {
  const theme = useApp((s) => s.settings.theme);
  const setTheme = useApp((s) => s.setTheme);
  const status = useApp((s) => s.status);
  const warming = useApp((s) => s.warming);
  const speaking = useApp((s) => s.speaking);
  const vis = dictationVisual(status, speaking, warming);
  // Build-time app version (from tauri.conf.json), shown next to the brand label.
  const [version, setVersion] = useState("");
  useEffect(() => {
    void appVersion()
      .then(setVersion)
      .catch(() => {}); // best-effort: a missing version just hides the readout
  }, []);

  return (
    <aside className="relative z-10 flex w-[228px] shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="flex items-center gap-2.5 px-5 pb-5 pt-6">
        <BrandMark />
        <div className="leading-none">
          {/* Family wordmark grammar (shared with faster-whisper-backend): light "faster"
              in ink + bold "whisper" in accent, and an accent "&gt;" prompt before the
              role label. Mirrored in docs/brand/lockup.html — keep the two in sync. */}
          <div className="font-display text-[15px] font-[430] tracking-tight text-text">
            faster<span className="font-[730] text-accent">whisper</span>
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-label text-faint">
            <span className="font-bold text-accent">&gt;</span> frontend
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {VISIBLE_SCREENS.filter((s) => s.id !== "settings").map(({ path, label, icon: Icon, end }) => (
          <NavLink
            key={path}
            to={path}
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
          <StatusDot tone={vis.tone} pulse={vis.pulse} filled={vis.filled} title={vis.label} />
          <span className="font-mono text-[11px]">{vis.label}</span>
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
            // Three-way cycle; "auto" follows the OS scheme (the default on fresh installs).
            onClick={() => setTheme(theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto")}
            title={theme === "auto" ? "Theme: auto (follows the system)" : theme === "dark" ? "Theme: dark" : "Theme: light"}
            className="ring-signal grid size-9 place-items-center rounded-xl text-dim hover:bg-surface-2 hover:text-text"
          >
            {theme === "auto" ? (
              <SunMoon className="size-[17px]" />
            ) : theme === "dark" ? (
              <Moon className="size-[17px]" />
            ) : (
              <Sun className="size-[17px]" />
            )}
          </button>
        </div>

        {/* Footer slot: version readout at rest; DWELLING on it for 2s reveals the
            year-round solidarity mark (the flag flickers into full colour). No
            title attr — a native tooltip would spoil the egg. The version sits in
            an absolute layer so the swap never shifts the layout. Decorative
            (aria-hidden flag); the slogan carries the meaning. */}
        <div className="pride-mark relative mt-3 flex items-center justify-center gap-2.5 px-3">
          {version && (
            <span className="version-readout absolute inset-0 grid place-items-center font-mono text-[10px] tracking-label text-faint">
              v{version}
            </span>
          )}
          <img src={PRIDE_FLAG_URI} alt="" aria-hidden className="pride-flag h-3 w-[19px] shrink-0 rounded-[2px]" />
          <span className="pride-slogan font-mono text-[9px] uppercase leading-[1.35] tracking-[0.12em] text-faint">
            sometimes antisocial
            <br />
            always antifascist
          </span>
        </div>
      </div>
    </aside>
  );
}
