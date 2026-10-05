import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useApp } from "@/lib/store";
import { Notice, Segmented, SectionLabel, Select, SettingRow } from "@/components/ui";
import { cn } from "@/lib/cn";
import { SETTING } from "@/lib/settingsManifest";
import {
  ACCENT_PRESETS, DEFAULT_ACCENT_HUE, DEFAULT_ACCENT_MOTION, DEFAULT_ARC_HUE, currentAccentHue, deriveAccent,
  fmtPer, motionCostNote, prefersReducedMotion, resolvedTheme, secToSlider, sliderToSec, subscribeAccentHue,
} from "@/lib/theme";
import type { AccentMotion, ThemeName } from "@/lib/types";

/* ── Appearance ────────────────────────────────────────────────────────── */

/** The slider's rainbow track: fixed OKLCH lightness/chroma, hue sweeping 0→360 —
 *  the same cut the swatches are derived from, so the track predicts the result. */
const HUE_TRACK = `linear-gradient(90deg, ${[0, 60, 120, 180, 240, 300, 360]
  .map((h) => `oklch(0.7 0.15 ${h})`)
  .join(", ")})`;
const HUE_WHEEL = `conic-gradient(${[0, 60, 120, 180, 240, 300, 360]
  .map((h) => `oklch(0.7 0.15 ${h})`)
  .join(", ")})`;

/** How long slider drags coalesce before reaching the store. Every store write
 *  re-derives and restamps the theme tokens (App.tsx's effect), so a raw
 *  `input` stream would repaint the whole app per pixel of drag. */
const HUE_WRITE_DEBOUNCE_MS = 60;

/** Theme + Signal colour. The theme row binds the same setting the sidebar
 *  button cycles; the colour rows are hue-only (theme.ts fixes L and C). */
export function AppearanceRows() {
  const theme = useApp((st) => st.settings.theme);
  const setTheme = useApp((st) => st.setTheme);
  const storedHue = useApp((st) => st.settings.accentHue ?? DEFAULT_ACCENT_HUE);
  const updateSettings = useApp((st) => st.updateSettings);
  const dark = resolvedTheme(theme) === "dark";

  // Local mirror of the hue so the slider tracks the pointer while store writes
  // are debounced; a store change from elsewhere (sync pull, reset) wins once no
  // write is pending.
  const [hue, setHue] = useState(storedHue);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pending.current === null) setHue(storedHue);
  }, [storedHue]);
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );
  const sliderRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (h: number) => {
      updateSettings({ accentHue: h });
    },
    [updateSettings],
  );
  const pick = (h: number) => {
    if (pending.current !== null) {
      clearTimeout(pending.current);
      pending.current = null;
    }
    setHue(h);
    commit(h);
  };
  const drag = (h: number) => {
    setHue(h);
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      commit(h);
    }, HUE_WRITE_DEBOUNCE_MS);
  };

  // "Custom" is a mode, not a hue: a preset's exact degree is still "custom" once the
  // wheel swatch was clicked (before, the ring only appeared after the slider had moved
  // off every preset), and picking a preset leaves the mode again.
  const preset = ACCENT_PRESETS.find(([, h]) => h === hue);
  const [customMode, setCustomMode] = useState(!preset);
  const custom = customMode || !preset;
  const pickPreset = (h: number) => {
    setCustomMode(false);
    pick(h);
  };
  const pickCustom = () => {
    setCustomMode(true);
    sliderRef.current?.focus();
  };

  // While the colour travels, a fixed pick has nothing to show: the rows grey out and
  // say what would bring them back (the arc chooses its own two ends below).
  const motion = useApp((st) => st.settings.accentMotion ?? DEFAULT_ACCENT_MOTION);
  const reduced = useReducedMotion();
  const moving = !reduced && motion.period > 0;
  const movingReason = "Motion is on, so the colour travels on its own. Set Motion to Still to pick a fixed colour.";

  return (
    <>
      <SectionLabel className="mb-1 mt-7">Appearance</SectionLabel>
      <SettingRow
        title={SETTING.theme.label}
        desc="Auto follows the system scheme. The sidebar button cycles the same setting."
      >
        <Segmented<ThemeName>
          value={theme}
          onChange={setTheme}
          ariaLabel={SETTING.theme.label}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "auto", label: "Auto" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title={SETTING.accentHue.label}
        desc="The accent for buttons, selection, chosen chips and charts. Recording red, live green, the armed amber and the working hues never change."
        disabled={moving}
        disabledReason={movingReason}
      >
        <div
          role="radiogroup"
          aria-label={SETTING.accentHue.label}
          className={cn("flex items-center gap-2 transition-opacity", moving && "opacity-50")}
        >
          {ACCENT_PRESETS.map(([name, h]) => (
            <HueSwatch key={name} name={name} hue={h} on={!custom && h === hue} dark={dark} disabled={moving} onPick={pickPreset} />
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={custom}
            aria-label="Custom"
            title="Custom hue"
            disabled={moving}
            onClick={pickCustom}
            className={cn(
              "ring-signal size-[26px] rounded-full transition-shadow disabled:cursor-not-allowed",
              custom && "ring-2 ring-text ring-offset-[3px] ring-offset-[color:var(--c-panel)]",
            )}
            style={{ background: HUE_WHEEL }}
          />
        </div>
      </SettingRow>
      <div className="pl-5">
        <SettingRow
          title="Custom hue"
          desc="Lightness and chroma are fixed per theme; only the hue is yours."
          disabled={moving}
          disabledReason={movingReason}
        >
          <div className={cn("flex flex-col gap-1.5 transition-opacity", moving && "opacity-50")}>
            <div className="flex items-center gap-3">
              <input
                ref={sliderRef}
                type="range"
                min={0}
                max={360}
                step={1}
                value={hue}
                disabled={moving}
                aria-label="Custom hue"
                onChange={(e) => {
                  setCustomMode(true);
                  drag(Number(e.target.value));
                }}
                className="ring-signal h-2 w-full min-w-[160px] cursor-pointer appearance-none rounded-pill disabled:cursor-not-allowed"
                style={{ background: HUE_TRACK }}
              />
              {/* Fixed width (the longest readout, "…59.9 min · 30 s … 7 d"), so the
                  slider keeps its size and place while the number changes under a drag. */}
              <span className="w-[36ch] shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-dim">
                {hue}° · {custom ? "custom" : preset![0].toLowerCase()}
              </span>
            </div>
          </div>
        </SettingRow>
      </div>
      <MotionRows dark={dark} motion={motion} reduced={reduced} baseHue={hue} />
    </>
  );
}

/** One preset swatch: a radio painted with the accent that hue derives to in this theme. */
function HueSwatch({
  name, hue, on, dark, disabled, role = "radio", badge, onPick,
}: {
  name: string;
  hue: number;
  on: boolean;
  dark: boolean;
  disabled?: boolean;
  /** "checkbox" for the arc's two-of-six palette (aria-checked still says "chosen"). */
  role?: "radio" | "checkbox";
  /** A one-character mark inside the swatch (the arc's "1"/"2" ends). */
  badge?: string;
  onPick: (h: number) => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={on}
      aria-label={badge ? `${name}, end ${badge}` : name}
      title={name}
      disabled={disabled}
      onClick={() => onPick(hue)}
      className={cn(
        "ring-signal grid size-[26px] place-items-center rounded-full font-mono text-[11px] font-semibold leading-none text-[color:var(--c-bg)] transition-shadow disabled:cursor-not-allowed",
        on && "ring-2 ring-text ring-offset-[3px] ring-offset-[color:var(--c-panel)]",
      )}
      style={{ background: deriveAccent(hue, dark).accent }}
    >
      {badge}
    </button>
  );
}

/* ── Motion ────────────────────────────────────────────────────────────── */

/** The dropdown's tiers (seconds per turn); "custom" opens the log slider. */
const MOTION_TIERS: { value: string; label: string }[] = [
  { value: "0", label: "Still" },
  { value: "604800", label: "One turn every 7 days" },
  { value: "86400", label: "Every day" },
  { value: "43200", label: "Every 12 hours" },
  { value: "21600", label: "Every 6 hours" },
  { value: "10800", label: "Every 3 hours" },
  { value: "3600", label: "Every hour" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "300", label: "Every 5 minutes" },
  { value: "180", label: "Every 3 minutes" },
  { value: "60", label: "Every minute" },
  { value: "custom", label: "Custom…" },
];
/** The preset hue nearest to `hue` on the wheel (the arc palette shows presets only). */
function nearestPreset(hue: number): number {
  let best = ACCENT_PRESETS[0][1];
  let bestD = 361;
  for (const [, h] of ACCENT_PRESETS) {
    const d = Math.abs(((((h - hue) % 360) + 540) % 360) - 180);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}
const REDUCED_MOTION_REASON = "Still — your system asks for reduced motion.";

/** Does the OS ask for reduced motion, tracked live. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Motion of the Signal colour: tier dropdown, the custom log-scale speed, the range
 *  (whole wheel / an arc to a second swatch) and a live "Right now" readout fed by this
 *  window's drift driver (theme.ts). The engine itself never touches `accentHue`: the
 *  hue you picked above is the base every turn starts from. */
/** The Motion cost notice (D71–D73), under the Custom speed row while Custom is picked
 *  (so the slider above it never moves) and under Motion otherwise. It fades and folds
 *  its height in and out instead of popping, and keeps the last text while it fades out. */
function CostNotice({ cost }: { cost: ReturnType<typeof motionCostNote> }) {
  const last = useRef(cost);
  if (cost) last.current = cost;
  const shown = last.current;
  return (
    // Always mounted, so a change of tier is announced; a live region that mounts
    // together with its text is announced unreliably.
    <div
      role="status"
      aria-live="polite"
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        cost ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
    >
      <div className="overflow-hidden">
        {/* Fading out, the old text stays for the eye but leaves the live region. */}
        {shown && (
          <div aria-hidden={cost ? undefined : true}>
            <Notice tone={shown.tone} className="mt-2.5">
              {shown.text}
            </Notice>
          </div>
        )}
      </div>
    </div>
  );
}

function MotionRows({
  dark, motion, reduced, baseHue,
}: { dark: boolean; motion: AccentMotion; reduced: boolean; baseHue: number }) {
  const updateSettings = useApp((st) => st.updateSettings);
  const commit = useCallback(
    (patch: Partial<AccentMotion>) => {
      const cur = useApp.getState().settings.accentMotion ?? DEFAULT_ACCENT_MOTION;
      updateSettings({ accentMotion: { ...cur, ...patch } });
    },
    [updateSettings],
  );

  // "Custom…" is a mode, not a value: a period that matches no tier reads as custom, and
  // picking Custom… while on a tier keeps the row open with the slider at that tier's
  // position until the thumb moves.
  const isTier = MOTION_TIERS.some((t) => t.value === String(motion.period));
  const [customMode, setCustomMode] = useState(!isTier);
  const custom = customMode || !isTier;
  const [slider, setSlider] = useState(() => secToSlider(motion.period || sliderToSec(500)));
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pending.current === null && motion.period > 0) setSlider(secToSlider(motion.period));
  }, [motion.period]);
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );
  const dragSpeed = (v: number) => {
    setSlider(v);
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      commit({ period: sliderToSec(v) });
    }, HUE_WRITE_DEBOUNCE_MS);
  };
  const pickTier = (v: string) => {
    if (v === "custom") {
      setCustomMode(true);
      commit({ period: sliderToSec(slider) });
      return;
    }
    setCustomMode(false);
    commit({ period: Number(v) });
  };

  // What the speed costs, said under the Motion row (D71–D73). Follows the slider while it
  // is dragged, before the debounced commit lands; reduced motion runs Still, so no cost.
  const livePeriod = custom ? sliderToSec(slider) : motion.period;
  const cost = reduced ? null : motionCostNote(livePeriod);

  // What the tokens show right now — the driver restamps them on every tick.
  const shownHue = useSyncExternalStore(subscribeAccentHue, currentAccentHue);
  const note = reduced
    ? REDUCED_MOTION_REASON
    : motion.period === 0
      ? "Still. The hue is exactly the Signal colour you picked above."
      : `${motion.range === "wheel" ? "Turning the whole wheel" : "Breathing between two colours"}, ${fmtPer(
          motion.period,
        )}. Every window computes this from the clock.`;
  // The arc's two ends. Older blobs started from the Signal colour; the preset nearest to
  // it stands in so the palette always shows two rings (the engine keeps the exact hue
  // until the next pick writes both ends).
  const arcTo = motion.arcHue ?? DEFAULT_ARC_HUE;
  const arcFrom = motion.arcFrom ?? nearestPreset(baseHue);
  // Two-of-six: a new pick becomes end 2 and the old end 2 becomes end 1, so two clicks
  // in a row set the pair in reading order and a single click swaps the far end.
  const pickArc = (h: number) => {
    if (h === arcFrom || h === arcTo) return;
    commit({ arcFrom: arcTo, arcHue: h });
  };
  const arcName = (h: number) => ACCENT_PRESETS.find(([, p]) => p === h)?.[0] ?? `${h}°`;

  return (
    <>
      <SettingRow
        title={SETTING.accentMotion.label}
        desc="How fast the Signal colour travels around the wheel. Still keeps it where you set it."
        disabled={reduced}
        disabledReason={REDUCED_MOTION_REASON}
        expand={custom ? undefined : <CostNotice cost={cost} />}
      >
        <Select<string>
          value={custom ? "custom" : String(motion.period)}
          onChange={pickTier}
          options={MOTION_TIERS}
          disabled={reduced}
          ariaLabel={SETTING.accentMotion.label}
          className="w-[220px]"
        />
      </SettingRow>
      {custom && (
        <div className="pl-5">
          <SettingRow
            title="Custom speed"
            desc="One full turn of the wheel takes this long."
            expand={<CostNotice cost={cost} />}
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1000}
                step={1}
                value={slider}
                aria-label="Seconds per turn (log scale)"
                onChange={(e) => dragSpeed(Number(e.target.value))}
                className="ring-signal h-2 w-full min-w-[160px] cursor-pointer appearance-none rounded-pill bg-surface-2"
              />
              {/* Fixed width (the longest readout, "…59.9 min · 30 s … 7 d"), so the
                  slider keeps its size and place while the number changes under a drag. */}
              <span className="w-[36ch] shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-dim">
                {fmtPer(sliderToSec(slider))} · 30 s … 7 d
              </span>
            </div>
          </SettingRow>
        </div>
      )}
      <SettingRow title="Range" desc="The whole wheel, or a breath between two colours you pick below.">
        <Segmented<AccentMotion["range"]>
          value={motion.range}
          onChange={(range) => commit(range === "arc" ? { range, arcFrom, arcHue: arcTo } : { range })}
          ariaLabel="Range"
          options={[
            { value: "wheel", label: "Whole wheel" },
            { value: "arc", label: "Between two colours" },
          ]}
        />
      </SettingRow>
      {motion.range === "arc" && (
        <div className="pl-5">
          <SettingRow
            title="Two colours"
            desc="Pick the two ends of the breath. A new pick becomes end 2; the previous end 2 moves to end 1."
          >
            <div className="flex items-center gap-3">
              <div role="group" aria-label="Two colours" className="flex items-center gap-2">
                {ACCENT_PRESETS.map(([name, h]) => (
                  <HueSwatch
                    key={name}
                    name={name}
                    hue={h}
                    role="checkbox"
                    on={h === arcFrom || h === arcTo}
                    badge={h === arcFrom ? "1" : h === arcTo ? "2" : undefined}
                    dark={dark}
                    onPick={pickArc}
                  />
                ))}
              </div>
              {/* Fixed width (the longest readout, "…59.9 min · 30 s … 7 d"), so the
                  slider keeps its size and place while the number changes under a drag. */}
              <span className="w-[36ch] shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-dim">
                {arcName(arcFrom)} ↔ {arcName(arcTo)}
              </span>
            </div>
          </SettingRow>
        </div>
      )}
      <SettingRow title="Right now" desc={note}>
        <span className="font-mono text-[11.5px] tabular-nums text-dim">{shownHue}°</span>
      </SettingRow>
    </>
  );
}
