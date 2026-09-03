import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Mic, Radio, Hand, Square, Pencil, LayoutDashboard } from "lucide-react";
import { screenEyebrow } from "@/lib/screens";
import { cn } from "@/lib/cn";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/store";
import { dictationVisual, isActiveDictation, isGracefulStop, isProcessing } from "@/lib/dictationVisual";
import { Button, Card, Notice, Toggle, routeParts } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { HotkeyChips } from "@/components/HotkeyChips";
import { HomeUsageStrip } from "@/components/UsageStats";
import { SetupChecklist } from "@/components/SetupChecklist";
import { stopLive, cancelLive, requestStopIfStarting, isCapturing } from "@/lib/streaming";
import { safeDisplayText, stripControlChars } from "@/lib/sanitize";
import { backendForProfile, homeTargetProfile, startHandsFree } from "@/lib/dictation";
import { configuredRouteTargets } from "@/lib/overlay";
import { languageLabel } from "@/lib/languages";
import type { Backend, Profile } from "@/lib/types";

const GLYPH = { hold: Mic, handsfree: Hand } as const;

/** The state word's colour by tone — the same tones the chip, the sidebar dot and the
 *  waveform use (armed = the fixed amber, never the accent). */
const STATE_TEXT: Record<string, string> = {
  faint: "text-faint",
  armed: "text-armed",
  live: "text-live",
  think: "text-think",
  translate: "text-[color:var(--c-translate)]",
  rec: "text-rec",
};

/** Subscribes to the high-frequency dictation `level` (~30Hz) on its own, so a level tick
 *  re-renders just this leaf — not all of Home + every ProfileCard. Waveform reads the level
 *  into a ref and self-animates via rAF, so isolating the subscription here costs nothing. */
function LiveWaveform(props: Omit<ComponentProps<typeof Waveform>, "level">) {
  const level = useApp((s) => s.level);
  return <Waveform level={level} {...props} />;
}

// After dictation ends, keep the live-transcript card on screen this long so you can
// read the final result, then it animates out. An empty/cancelled session lingers the
// same amount, for consistent behaviour.
const TRANSCRIPT_LINGER_MS = 10000;

/** The next dictation's route for one profile, resolved as the chip's and the session's
 *  are: the profile's language over the bound backend's, the backend's translation
 *  defaults under the profile's overrides. Both halves are peer-authored (a sync pull can
 *  land them), so they go through `languageLabel` + routeParts' bounds. */
function profileRoute(p: Profile | undefined, backend: Backend | undefined): string {
  const lang = p?.language?.trim() ? p.language : (backend?.language ?? "auto");
  const route = routeParts(languageLabel(lang), configuredRouteTargets(p, backend));
  return (route.source || "auto") + (route.targets.length ? ` → ${route.targets.join(", ")}${route.more ? ` +${route.more}` : ""}` : "");
}

/** The same route as codes — "DE → EN, FR" — the way the chip and the tray write it, for
 *  the row's narrow column; the full names ride on the cell's tooltip. */
function profileRouteShort(p: Profile | undefined, backend: Backend | undefined): string {
  const code = (v: string) => safeDisplayText(v.trim(), 8).toUpperCase();
  const lang = p?.language?.trim() ? p.language : (backend?.language ?? "");
  const source = lang && lang !== "auto" ? code(lang) : "auto";
  const targets = (configuredRouteTargets(p, backend) ?? []).filter((t) => typeof t === "string" && t.trim()).map(code);
  return source + (targets.length ? ` → ${targets.slice(0, 3).join(", ")}${targets.length > 3 ? ` +${targets.length - 3}` : ""}` : "");
}

/** The deck is ONE grid: the header and every row are subgrids of it, so each column is
 *  at least as wide as its widest cell across all rows, so nothing truncates and the
 *  columns line up. `auto` tracks then share the spare width EQUALLY on top of their
 *  content (a single `fr` track would swallow it all instead); the edit + toggle column
 *  is `max-content`, which never stretches. */
const DECK_COLS = "grid-cols-[auto_auto_auto_auto_auto_max-content]";
const ROW_COLS = "col-span-full grid-cols-subgrid";

/** One profile as a row of the dictate card (D46 C): name and activation, hotkey, model,
 *  endpoint, language, then edit + enable. Clicking an enabled row makes it the profile the
 *  button dictates with; the chosen row is tinted, the one running a session carries the
 *  state word. A disabled row is dimmed and not selectable — enable it first. */
function ProfileRow({ p, chosen, running, runningLabel, onChoose }: { p: Profile; chosen: boolean; running: boolean; runningLabel: string; onChoose: () => void }) {
  const backends = useApp((s) => s.backends);
  const updateProfile = useApp((s) => s.updateProfile);
  const navigate = useNavigate();
  const backend = backends.find((b) => b.id === p.backendId);
  const Glyph = GLYPH[p.activation];
  const name = safeDisplayText(p.name, 80);
  return (
    <div
      role="row"
      aria-selected={chosen}
      onClick={p.enabled ? onChoose : undefined}
      onKeyDown={(e) => { if (p.enabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onChoose(); } }}
      tabIndex={p.enabled ? 0 : -1}
      title={p.enabled ? (chosen ? "The button dictates with this profile" : "Click: the button dictates with this profile") : "Enable the profile to use it"}
      className={cn(
        "ring-signal grid items-center border-t border-line px-6 py-3.5 outline-none transition-colors",
        ROW_COLS,
        p.enabled ? "cursor-pointer" : "opacity-50",
        chosen ? "bg-accent-soft" : p.enabled && "hover:bg-surface-2/60",
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn("grid size-9 shrink-0 place-items-center rounded-xl", chosen ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent")}>
          <Glyph className="size-[18px]" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            {/* A name is user text (up to 80 chars): it alone is capped, so the column's
                content minimum comes from the short activation hint or a sane name width. */}
            <span className="max-w-[28ch] truncate text-[14px] font-semibold text-text" title={name}>{name}</span>
            {running && <span className="rounded-pill border border-line px-2 py-px font-mono text-[10px] uppercase tracking-label text-dim">{runningLabel}</span>}
          </div>
          <div className="whitespace-nowrap text-[12px] text-dim">{p.activation === "hold" ? "Hold to talk" : "Tap to start and stop"}</div>
        </div>
      </div>
      <HotkeyChips codes={p.hotkey} />
      <div className="whitespace-nowrap font-mono text-[12px] text-text">{safeDisplayText(p.model?.trim() || backend?.model, 40) || "—"}</div>
      <div className="whitespace-nowrap font-mono text-[12px] text-accent">{p.endpoint ?? backend?.endpoint ?? "—"}</div>
      <div className="whitespace-nowrap font-mono text-[12px] text-text" title={`${profileRoute(p, backend)}${backend ? ` · ${safeDisplayText(backend.name, 80)}` : " · No backend"}`}>{profileRouteShort(p, backend)}</div>
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" title="Edit profile" onClick={() => navigate(`/profiles?edit=${p.id}`)}>
          <Pencil className="size-4" />
        </Button>
        <Toggle ariaLabel={`Enable ${name}`} checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
      </div>
    </div>
  );
}

// Subscribes to the live `partial` transcript itself, so the several-times-a-second partial
// updates re-render ONLY this line — not the whole Home tree (the hero hotkey rows, the
// profile rows don't depend on the transcript). Mirrors how
// the 30Hz level meter is isolated inside LiveWaveform.
// The chip caps its own copy of this at 400 chars; the same cap has to exist here, because the
// partial is 100% server-authored and this card is WRAPPING — a multi-megabyte partial becomes
// millions of line boxes, re-laid-out several times a second, and freezes the main window.
// Render-only, and a tail slice: only the end of a live partial is of any use while speaking.
const MAX_PARTIAL_CHARS = 4000;

function LiveTranscriptText() {
  const partial = useApp((s) => s.partial);
  // Cf/bidi survive the Rust bound by design (see the Overlay twin): the transcript keeps its
  // newlines, so `bounded` is used instead of `bounded_server_text`. Strip them here, at the one
  // surface whose whole purpose is letting the user supervise the text before it is typed.
  return <>{stripControlChars(partial.slice(-MAX_PARTIAL_CHARS)) || <span className="text-faint">…</span>}</>;
}

/** Free-software apps the hero names while hovered — the promise is "any field", so the
 *  list is only apps whose fields the app can actually type into on a Linux desktop. */
const HERO_APPS = [
  "LibreWolf", "Betterbird", "Firefox", "Thunderbird", "LibreOffice", "Kate", "Signal", "Element",
  "VSCodium", "Neovim", "GIMP", "Inkscape", "Joplin", "Logseq", "Konsole", "KMail", "Kdenlive", "Emacs",
] as const;

/** "Speak into any field." — while the pointer rests on the title, the last words cycle
 *  through free apps in random order ("Speak into LibreWolf.", …), each sliding up out of
 *  the previous one, and settle back on "any field." when it leaves. The hover target is
 *  the whole title, not the changing word: a shorter name would otherwise shrink the
 *  target from under the pointer and reset the cycle. Reduced motion swaps the word
 *  without the slide. Pure decoration: the accessible name stays the static sentence. */
function HeroTitle() {
  const [hover, setHover] = useState(false);
  const [i, setI] = useState(-1);
  const reduced = useReducedMotion();
  // A shuffled deck: every name is dealt once before any repeats; a fresh shuffle starts
  // when the deck runs out, never opening with the name that just closed the last one.
  const deck = useRef<number[]>([]);
  useEffect(() => {
    if (!hover) { setI(-1); return; }
    const next = (cur: number) => {
      if (deck.current.length === 0) {
        const d = HERO_APPS.map((_, k) => k);
        for (let a = d.length - 1; a > 0; a--) {
          const b = Math.floor(Math.random() * (a + 1));
          [d[a], d[b]] = [d[b], d[a]];
        }
        if (d[0] === cur && d.length > 1) [d[0], d[1]] = [d[1], d[0]];
        deck.current = d;
      }
      return deck.current.shift() ?? 0;
    };
    // A moment of rest first, so a pointer passing over the title does not flip it.
    let t: ReturnType<typeof setInterval> | undefined;
    const d = setTimeout(() => {
      setI((n) => (n < 0 ? next(-1) : n));
      t = setInterval(() => setI(next), 2500);
    }, 800);
    return () => { clearTimeout(d); if (t) clearInterval(t); };
  }, [hover]);
  const word = i < 0 ? "any field" : HERO_APPS[i];
  return (
    <h1
      className="mt-2 flex items-center gap-3 font-display text-[40px] font-bold leading-none tracking-tight text-text"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Speak into any field."
    >
      <LayoutDashboard className="size-8 text-accent" aria-hidden />
      <span className="inline-flex items-baseline" aria-hidden>
        <span>Speak into&nbsp;</span>
        <span className="relative -mb-[0.12em] inline-grid overflow-hidden pb-[0.12em] align-baseline">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={word}
              className={cn("col-start-1 row-start-1 whitespace-nowrap", i >= 0 && "text-accent")}
              initial={reduced ? { opacity: 0 } : { y: "110%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { y: "-110%", opacity: 0 }}
              transition={reduced ? { duration: 0.12 } : { type: "spring", stiffness: 420, damping: 34 }}
            >
              {word}.
            </motion.span>
          </AnimatePresence>
        </span>
      </span>
    </h1>
  );
}

export default function Dashboard() {
  const profiles = useApp((s) => s.profiles);
  const backends = useApp((s) => s.backends);
  const status = useApp((s) => s.status);
  const warming = useApp((s) => s.warming);
  const speaking = useApp((s) => s.speaking);
  const dictationError = useApp((s) => s.dictationError);
  const overridesIgnored = useApp((s) => s.overridesIgnored);
  const micId = useApp((s) => s.settings.microphoneId);
  const homeProfileId = useApp((s) => s.settings.homeProfileId);
  const activeProfile = useApp((s) => s.activeProfile);
  const updateSettings = useApp((s) => s.updateSettings);

  const enabled = profiles.filter((p) => p.enabled);
  // The hero button has no held chord (you click it), so it always dictates hands-free
  // style. It targets the profile picked below — falling back to the first enabled
  // hands-free profile, then any enabled — and uses that profile's backend + overrides.
  const target = homeTargetProfile(profiles, homeProfileId);
  const headerBackend: Backend | undefined = backendForProfile(target, backends);
  // While a session is live, the hero READOUTS (model / endpoint / language) describe the
  // RUNNING profile — like the chip + usage do — not the home-button target, which can drift if
  // the profile set changes mid-session (disabling the active profile, reordering, deleting). The
  // button/start logic + the row choice keep using `target` (the next-dictation pick, a config choice).
  // activeProfile is null when idle, so this falls back to the home target then.
  const shown = (activeProfile ? profiles.find((p) => p.id === activeProfile) : undefined) ?? target;
  // The next dictation's ROUTE: the language spoken → the languages it is turned into.
  // Effective language resolves exactly as the chip's does (profile override, else the
  // bound backend), and both halves go through `languageLabel` + routeParts' bounds —
  // `model`/`language` are peer-authored and arrive on an unattended sync pull.

  // "Busy" = any non-idle state; the hero button is a stop/cancel while busy. We keep
  // a graceful stop for "listening" (deliver the last words) but force a hard reset
  // for the post-speech states — so a wedged "finalizing…"/"inserting…" (e.g. the
  // stream died on suspend) is recoverable with the same button instead of dead.
  const busy = isActiveDictation(status);
  // Shared state→colour mapping (same as the chip + sidebar): off=grey, armed=amber,
  // speaking=green, finalizing=neutral, error=neutral. OFF/idle reads as a recessed
  // neutral button (press to start) — NOT the old always-amber — and only goes amber
  // once a session is armed, green while you speak. The waveform has no hollow form,
  // so its "off" tone maps to grey (dim) rather than amber.
  const vis = dictationVisual(status, speaking, warming);
  const heroFill =
    vis.state === "speaking"
      ? "bg-live text-white"
      : vis.state === "processing"
        ? vis.tone === "translate"
          ? "bg-translate text-white" // the T2T stage's own tone — the waveform, sidebar dot and chip all show it
          : "bg-think text-white"
        : vis.state === "armed"
          ? // The fixed armed amber (--c-armed), not the accent: the Signal colour may be any hue
            // and may drift. Armed is always amber in both themes, so its ink is a constant too
            // (the same dark ink app.css pairs with the stock amber accent).
            "bg-armed text-[#1a1207]"
          : "bg-surface-2 text-dim";
  const waveTone = vis.tone === "faint" ? "dim" : vis.tone;
  // Mirror the chip (Overlay working = processing || warming): vis.state is "processing" for
  // transcribing/injecting AND cold-mic warm-up, so the bars self-sweep during warm-up instead of
  // sitting flat at the ~0 level a warming mic delivers — matching heroFill and the chip.
  const waveProcessing = vis.state === "processing";

  // The live-transcript card is shown while a session is live (or on error), then
  // LINGERS briefly after it ends so the final transcript stays readable, before it
  // animates out. Tied to the session — not a stale `partial` — so it behaves the same
  // whether or not you actually said anything. While lingering at idle the header reads
  // "done" rather than the resting "off".
  const cardActive = busy || status === "error";
  const cardLabel = cardActive ? vis.label : "done";
  const [cardVisible, setCardVisible] = useState(false);
  useEffect(() => {
    if (cardActive) {
      setCardVisible(true);
      return;
    }
    const t = setTimeout(() => setCardVisible(false), TRANSCRIPT_LINGER_MS);
    return () => clearTimeout(t);
  }, [cardActive]);
  const toggle = () => {
    // A processing status with the mic still open (a per-phrase translate) is a STOP, not
    // a cancel — the session is alive and the user asked to end it, not discard it.
    if (isGracefulStop(status, isCapturing())) {
      void stopLive();
      return;
    }
    if (isProcessing(status)) {
      void cancelLive(); // force a clean idle (and reset any stuck hotkeys)
      return;
    }
    // A toggle-off that lands during the start prologue (status still "idle", session
    // mid-start) would otherwise fall through to start and be swallowed by startLive's
    // startingSession guard, wedging the just-started hands-free session. Honor it like the hotkey
    // (dictate) and chip (runOverlayAction) toggles do.
    if (requestStopIfStarting()) return;
    // idle or error → start fresh (startLive clears any prior error).
    if (!headerBackend) return;
    // Stamps the active Profile for the chip, honours "Ask for target languages", and
    // resolves effective language / prompt / decode (target over backend); target may be
    // undefined → the backend's own defaults are used.
    startHandsFree(headerBackend, micId, target);
  };

  return (
    <div className="page page-cards">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">{screenEyebrow("dashboard")}</div>
          <HeroTitle />
          <p className="mt-3 text-[14px] text-dim">
            Choose between push-to-talk and hands-free. Audio streams to your <strong className="font-semibold text-text">faster-whisper-backend</strong> server or any OpenAI API-compatible whisper server.
            <br />
            The result appears wherever your cursor is.
          </p>
        </div>
      </div>

      {/* Usage at a glance — sparkline tiles between the heading and the dictation
          instrument; the full chart lives on /statistics. */}
      <HomeUsageStrip />

      {/* First-run / re-setup checklist — renders only while a backend or all
          profiles are missing (the dictate hero below is inert until then). */}
      <SetupChecklist />

      {/* The dictate card (D46 C, the deck): the control strip on top — button, state word,
          what pressing does, the meter — then every profile as a row. The tinted row is the
          one the button dictates with; click another enabled row to switch. */}
      <Card className="mt-8 overflow-hidden p-0">
        <div className="flex items-center gap-6 px-6 py-6">
          <button
            type="button"
            onClick={(e) => {
              // Blur immediately. With "Press Enter after" enabled, stopping via
              // this button leaves it focused; the autoEnter Return injected on
              // stop would then land on the focused button (Enter = activate) and
              // restart dictation. Dropping focus sends that Return to <body> (a
              // no-op) instead. The hotkey path is unaffected (the target app, not
              // our window, has focus there).
              e.currentTarget.blur();
              toggle();
            }}
            className={
              "ring-signal grid size-16 shrink-0 place-items-center rounded-full transition-colors transition-transform hover:scale-105 " +
              heroFill
            }
            title={
              // Same predicate as the click: a per-phrase translate keeps the mic open under
              // "translating", where a click DELIVERS the words — not "Cancel (force stop)".
              isGracefulStop(status, isCapturing())
                ? "Stop dictation"
                : busy
                  ? "Cancel (force stop)"
                  : "Start a live dictation"
            }
          >
            {busy ? <Square className="size-6" /> : <Mic className="size-7" />}
          </button>
          <div className="min-w-0">
            <div className={cn("flex items-center gap-2 font-mono text-[11px] uppercase tracking-label", STATE_TEXT[vis.tone] ?? "text-faint")}>
              <i className={cn("inline-block size-[7px] rounded-full bg-current", vis.pulse && "animate-pulse")} aria-hidden />
              {vis.label}
            </div>
            <div className="mt-1 text-[16px] font-semibold text-text">
              {!enabled.length ? "Enable a profile to begin" : busy ? (isGracefulStop(status, isCapturing()) ? "Press again to stop" : "Press to cancel") : target ? `Press to dictate with ${safeDisplayText(target.name, 80)}` : "Press to dictate"}
            </div>
            <div className="mt-0.5 text-[12.5px] text-faint">
              {enabled.length ? "Or use a profile’s hotkey from any app · the transcript appears wherever your cursor is." : "The button and the hotkeys stay off until a profile is enabled."}
            </div>
          </div>
          <LiveWaveform
            active={status === "listening" && !warming}
            processing={waveProcessing}
            tone={waveTone}
            bars={40}
            variant="bars"
            pride
            className="ml-auto h-12 w-64 shrink-0"
          />
        </div>
        {profiles.length === 0 ? (
          <div className="border-t border-line px-6 py-5 text-[13.5px] text-dim">No profiles yet — add one on the Profiles screen.</div>
        ) : (
          <div role="grid" aria-label="Profiles — the tinted row is the one the button dictates with" className={cn("grid gap-x-5", DECK_COLS)}>
            <div role="row" className={cn("grid border-t border-line bg-surface/40 px-6 py-2 font-mono text-[10px] uppercase tracking-label text-faint", ROW_COLS)}>
              <span>profile</span>
              <span>hotkey</span>
              <span>model</span>
              <span>endpoint</span>
              {/* Spans the language column AND the edit/toggle column, so the long header runs to
                  the card's right edge instead of being squeezed by the buttons' track. */}
              <span className="col-span-2 whitespace-nowrap" title="The language you speak → the languages the text is translated into">language · spoken → translated</span>
            </div>
            {profiles.map((p) => (
              <ProfileRow
                key={p.id}
                p={p}
                chosen={p.id === target?.id}
                running={busy && p.id === shown?.id}
                runningLabel={vis.label}
                onChoose={() => updateSettings({ homeProfileId: p.id })}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Live-transcript card: visible while busy/error, then lingers for a few
          seconds after the session ends (so the final transcript stays readable) and
          animates in/out by collapsing its height + fading. */}
      <AnimatePresence initial={false}>
        {cardVisible && (
          <motion.div
            key="transcript"
            initial={{ opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: "auto", marginTop: 16 }}
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <Card className="p-5">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-label text-faint">
                <LiveWaveform
                  active={status === "listening" && !warming}
                  processing={waveProcessing}
                  bars={5}
                  variant="dots"
                  tone={waveTone}
                  className="h-4 w-10"
                />
                {cardLabel}
              </div>
              {status === "error" && dictationError ? (
                <div className="select-text text-[13.5px] leading-relaxed text-rec">
                  {safeDisplayText(dictationError, 500)}
                </div>
              ) : (
                <div className="min-h-6 select-text whitespace-pre-wrap text-[15px] leading-relaxed text-text">
                  <LiveTranscriptText />
                </div>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {overridesIgnored.length > 0 && (
        <Notice className="mt-3">
          Server ignored {overridesIgnored.length} override
          {overridesIgnored.length === 1 ? "" : "s"} (locked by the server admin):{" "}
          <span className="font-mono text-[12px]">{overridesIgnored.join(", ")}</span>.
        </Notice>
      )}

      <div className="mt-4 flex items-center gap-2 px-1 text-[12px] text-faint">
        <Radio className="size-3.5" />
        Streaming backends show a live transcript in the chip while you speak.
      </div>
    </div>
  );
}
