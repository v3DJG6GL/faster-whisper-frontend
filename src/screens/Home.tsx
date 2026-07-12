import { useEffect, useState, type ComponentProps } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Mic, Radio, Hand, Square, Pencil } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/store";
import { dictationVisual, isActiveDictation, isProcessing } from "@/lib/dictationVisual";
import { Button, Card, Notice, SectionLabel, Select, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { HotkeyChips } from "@/components/HotkeyChips";
import { HomeUsageStrip } from "@/components/UsageStats";
import { SetupChecklist } from "@/components/SetupChecklist";
import { startLive, stopLive, cancelLive, requestStopIfStarting } from "@/lib/streaming";
import { backendForProfile, homeTargetProfile } from "@/lib/dictation";
import type { Backend, Profile } from "@/lib/types";

const GLYPH = { hold: Mic, latch: Hand } as const;

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

function ProfileCard({ p }: { p: Profile }) {
  const backends = useApp((s) => s.backends);
  const updateProfile = useApp((s) => s.updateProfile);
  const navigate = useNavigate();
  const backend = backends.find((b) => b.id === p.backendId);
  const Glyph = GLYPH[p.activation];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
            <Glyph className="size-[18px]" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-text">{p.name}</div>
            <div className="text-[12px] text-dim">
              {p.activation === "hold" ? "Hold the hotkey while you speak" : "Tap once to start, tap again to stop"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            title="Edit profile"
            onClick={() => navigate(`/profiles?edit=${p.id}`)}
          >
            <Pencil className="size-4" />
          </Button>
          <Toggle ariaLabel={`Enable ${p.name}`} checked={p.enabled} onChange={(v) => updateProfile(p.id, { enabled: v })} />
        </div>
      </div>
      <div className="mt-5 flex items-center justify-between">
        <HotkeyChips codes={p.hotkey} />
        <div className="text-right">
          <div className="font-mono text-[11px] uppercase tracking-label text-faint">{p.endpoint ?? backend?.endpoint ?? "—"}</div>
          <div className="text-[12.5px] text-dim">{backend?.name ?? "No backend"}</div>
        </div>
      </div>
    </Card>
  );
}

// Subscribes to the live `partial` transcript itself, so the several-times-a-second partial
// updates re-render ONLY this line — not the whole Home tree (the hero hotkey rows, the
// profile-picker Select, and the ProfileCard grid don't depend on the transcript). Mirrors how
// the 30Hz level meter is isolated inside LiveWaveform.
function LiveTranscriptText() {
  const partial = useApp((s) => s.partial);
  return <>{partial || <span className="text-faint">…</span>}</>;
}

export default function Home() {
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
  const setDictation = useApp((s) => s.setDictation);

  const enabled = profiles.filter((p) => p.enabled);
  // The hero button has no held chord (you click it), so it always dictates in latch
  // style. It targets the profile picked below — falling back to the first enabled
  // latch profile, then any enabled — and uses that profile's backend + overrides.
  const target = homeTargetProfile(profiles, homeProfileId);
  const headerBackend: Backend | undefined = backendForProfile(target, backends);
  // While a session is live, the hero READOUTS (model / endpoint / language) describe the
  // RUNNING profile — like the chip + usage do — not the home-button target, which can drift if
  // the profile set changes mid-session (disabling the active profile, reordering, deleting). The
  // button/start logic + the Select keep using `target` (the next-dictation pick, a config choice).
  // activeProfile is null when idle, so this falls back to the home target then.
  const shown = (activeProfile ? profiles.find((p) => p.id === activeProfile) : undefined) ?? target;
  const shownBackend: Backend | undefined = backendForProfile(shown, backends);

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
        ? "bg-think text-white"
        : vis.state === "armed"
          ? "bg-accent text-accent-ink"
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
    if (status === "listening") {
      void stopLive();
      return;
    }
    if (isProcessing(status)) {
      void cancelLive(); // force a clean idle (and reset any stuck hotkeys)
      return;
    }
    // A toggle-off that lands during the start prologue (status still "idle", session
    // mid-start) would otherwise fall through to start and be swallowed by startLive's
    // startingSession guard, wedging the just-started latch. Honor it like the hotkey
    // (dictate) and chip (runOverlayAction) toggles do.
    if (requestStopIfStarting()) return;
    // idle or error → start fresh (startLive clears any prior error).
    if (!headerBackend) return;
    // Tell the overlay chip which Profile is dictating (the hotkey path does this in
    // dictate(); the button bypasses it). null when only a backend is targeted.
    setDictation({ activeProfile: target?.id ?? null });
    // startLive resolves effective language / prompt / decode (target over backend);
    // target may be undefined → the backend's own defaults are used.
    void startLive(headerBackend, micId, "latch", target);
  };

  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-label text-accent">faster-whisper · dictation</div>
          <h1 className="mt-2 font-display text-[40px] font-bold leading-none tracking-tight text-text">
            Speak into any field.
          </h1>
          <p className="mt-3 max-w-md text-[14px] text-dim">
            Push-to-talk or latch it on. Audio streams to your own faster-whisper backend and the text appears wherever your cursor is.
          </p>
        </div>
      </div>

      {/* Usage at a glance — sparkline tiles between the heading and the dictation
          instrument; the full chart lives on /statistics. */}
      <HomeUsageStrip />

      {/* First-run / re-setup checklist — renders only while a backend or all
          profiles are missing (the dictate hero below is inert until then). */}
      <SetupChecklist />

      {/* Hero instrument */}
      <Card className="mt-8 overflow-hidden p-0">
        <div className="flex items-center gap-6 px-8 py-7">
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
              status === "listening"
                ? "Stop dictation"
                : busy
                  ? "Cancel (force stop)"
                  : "Start a live dictation"
            }
          >
            {busy ? <Square className="size-6" /> : <Mic className="size-7" />}
          </button>
          <div className="min-w-0 flex-1 space-y-1">
            {enabled.length > 0 ? (
              enabled.slice(0, 4).map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-[15px] text-text">
                  <span className="text-dim">{p.activation === "hold" ? "Hold" : "Tap"}</span>
                  <HotkeyChips codes={p.hotkey} />
                  <span className="text-dim">{p.activation === "hold" ? "to talk" : "to latch"}</span>
                  <span className="truncate text-[12.5px] text-faint">· {p.name}</span>
                </div>
              ))
            ) : (
              <div className="text-[15px] text-dim">Enable a profile below to begin.</div>
            )}
            {enabled.length > 0 && (
              <div className="flex items-center gap-2 pt-1 text-[12.5px] text-dim">
                <span className="shrink-0">The button dictates with</span>
                <Select
                  value={target?.id ?? ""}
                  onChange={(v) => updateSettings({ homeProfileId: v })}
                  options={enabled.map((p) => ({ value: p.id, label: p.name }))}
                  className="w-40"
                  ariaLabel="Profile the Home button dictates with"
                />
              </div>
            )}
            <div className="pt-0.5 text-[12.5px] text-faint">
              The transcript appears wherever your cursor is.
            </div>
          </div>
          <LiveWaveform
            active={status === "listening" && !warming}
            processing={waveProcessing}
            tone={waveTone}
            bars={28}
            variant="bars"
            pride
            className="h-12 w-48"
          />
        </div>
        <div className="grid grid-cols-3 border-t border-line font-mono text-[12px]">
          <Readout label="model" value={shownBackend?.model ?? "—"} />
          <Readout label="endpoint" value={shown?.endpoint ?? shownBackend?.endpoint ?? "—"} accent />
          <Readout
            label="language"
            value={shown?.language?.trim() ? shown.language : (shownBackend?.language ?? "auto")}
            last
          />
        </div>
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
                <div className="select-text text-[13.5px] leading-relaxed text-rec">{dictationError}</div>
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

      <SectionLabel className="mb-3 mt-10">Profiles</SectionLabel>
      {profiles.length === 0 ? (
        <Card className="p-6 text-[13.5px] text-dim">
          No profiles yet — add one on the Profiles screen.
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {profiles.map((p) => (
            <ProfileCard key={p.id} p={p} />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2 px-1 text-[12px] text-faint">
        <Radio className="size-3.5" />
        Streaming backends show a live transcript in the chip while you speak.
      </div>
    </div>
  );
}

function Readout({ label, value, accent, last }: { label: string; value: string; accent?: boolean; last?: boolean }) {
  return (
    <div className={"px-8 py-4 " + (!last ? "border-r border-line" : "")}>
      <div className="text-[10px] uppercase tracking-label text-faint">{label}</div>
      <div className={"mt-1 truncate text-[13px] " + (accent ? "text-accent" : "text-text")}>{value}</div>
    </div>
  );
}
