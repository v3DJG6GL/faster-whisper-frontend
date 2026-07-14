import { useState, useEffect, useCallback, useRef } from "react";
import { Mic, Check, Play, RefreshCw, Square, ArrowUp, ArrowDown, Trash2, Plus, FolderOpen } from "lucide-react";
import { useApp } from "@/lib/store";
import { swap } from "@/lib/arr";
import { Button, Card, Segmented, SectionLabel, Select, SettingRow, Stepper, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { VISIBLE_SCREENS, OVERLAY_ACTIONS, quickLaunchMeta } from "@/lib/screens";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/cn";
import {
  listAudioDevices,
  startMicTest,
  stopMicTest,
  playMicTest,
  stopMicTestPlayback,
  onMicTestPlayEnded,
  onAudioLevel,
  evdevStatus,
  evdevSetup,
  setDeepFieldDetection,
  openRecordingsDir,
  recordingsDirPath,
  pickRecordingsDir,
  type EvdevStatus,
} from "@/lib/api";
import type { AudioDevice, OverlayQuickAction, RecordingSettings } from "@/lib/types";
import { PASTE_PRESETS, pasteKey, pasteCodes } from "@/lib/paste";
import { SyncTab } from "@/screens/SettingsSync";
import { HotkeyCaptureControl } from "@/components/HotkeyCaptureControl";
import { useHotkeyCapture } from "@/lib/useHotkeyCapture";

const TABS = ["General", "Audio", "Recording", "Chip", "Sync", "Permissions"] as const;
type Tab = (typeof TABS)[number];

// The keys of RecordingSettings whose value is a boolean (the chip-visibility flags).
type ChipVisKey = {
  [K in keyof RecordingSettings]: RecordingSettings[K] extends boolean ? K : never;
}[keyof RecordingSettings];

// The chip's visibility settings are all the same Off / Always / On-hover tri-state, backed by a
// (visible, onHover) boolean pair on RecordingSettings. One control keyed on those two fields keeps
// the four identical Segmented blocks (live transcript / profile / usage / target) from drifting.
function HoverModeSegmented({
  visibleKey,
  hoverKey,
  disabled,
  ariaLabel,
}: {
  visibleKey: ChipVisKey;
  hoverKey: ChipVisKey;
  disabled?: boolean;
  // Names the role="group" so a screen reader can tell the four identical Off/Always/On-hover
  // triplets apart (SettingRow auto-labels only a direct Toggle/Select child, not this composite).
  ariaLabel?: string;
}) {
  const visible = useApp((st) => st.settings.recording[visibleKey]);
  const onHover = useApp((st) => st.settings.recording[hoverKey]);
  const updateRecording = useApp((st) => st.updateRecording);
  return (
    <Segmented
      ariaLabel={ariaLabel}
      value={!visible ? "off" : onHover ? "hover" : "always"}
      onChange={(v) =>
        updateRecording(
          (v === "off"
            ? { [visibleKey]: false }
            : v === "hover"
              ? { [visibleKey]: true, [hoverKey]: true }
              : { [visibleKey]: true, [hoverKey]: false }) as Partial<RecordingSettings>,
        )
      }
      disabled={disabled}
      options={[
        { value: "off", label: "Off" },
        { value: "always", label: "Always" },
        { value: "hover", label: "On hover" },
      ]}
    />
  );
}

// Smoothed level above the digital-silence floor ⇒ the mic is actually capturing (a
// cold/Bluetooth mic can be open but silent for ~1–2s first). A live mic has a faint
// noise floor (~0.0002) even in silence; a warming one is exact zero. Mirrors streaming.ts.
const MIC_LIVE_LEVEL = 0.0001;
// Cap a mic test so it can't hold the mic open indefinitely (a Bluetooth headset would
// stay stuck in low-quality mic mode the whole time). Plenty for a "does it work?" check.
const MIC_TEST_MAX_MS = 15000;

function AudioTab() {
  const microphoneId = useApp((s) => s.settings.microphoneId);
  const updateSettings = useApp((s) => s.updateSettings);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  // Mic is open but not yet delivering real audio (cold/Bluetooth warm-up) → show "warming up…".
  const [micWarming, setMicWarming] = useState(false);
  // True once a stopped test captured something worth replaying (enables Replay).
  const [hasClip, setHasClip] = useState(false);
  // Whether a replay is currently sounding — drives the button label and guards
  // against starting a second, overlapping playback.
  const [playing, setPlaying] = useState(false);
  const clipSecsRef = useRef(0);
  const playTimerRef = useRef<number | null>(null);
  // Latest "stop + offer replay" handler, so the auto-stop timer (armed in an effect defined
  // above the handler) can call it without a declaration-order / stale-closure problem.
  const stopAndReplayRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      setDevices(await listAudioDevices());
    } catch (e) {
      console.error("listing audio devices failed:", e); // keep prior list; don't float the rejection
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mic test: subscribe to levels and open the device while `testing` is on.
  useEffect(() => {
    if (!testing) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    // Show "warming up…" until real audio flows (a cold/Bluetooth mic is silent for
    // ~1–2s first), with a safety timeout so it never hangs on a silent device.
    setMicWarming(true);
    const warmTimer = window.setTimeout(() => setMicWarming(false), 5000);
    // Auto-stop so the test can't run (and hold the mic) forever.
    const maxTimer = window.setTimeout(() => {
      // Auto-stop: take the SAME path as pressing Stop, so the captured clip is offered for replay
      // too (the bare setTesting(false) skipped the capture, leaving no Replay button after timeout).
      if (active) void stopAndReplayRef.current();
    }, MIC_TEST_MAX_MS);
    void (async () => {
      const un = await onAudioLevel((l) => {
        if (!active) return;
        setLevel(l);
        if (l > MIC_LIVE_LEVEL) setMicWarming(false);
      });
      // Torn down mid-await (test toggled off / device switched) → don't leave the
      // level listener registered for the rest of the session.
      if (!active) {
        un();
        return;
      }
      unlisten = un;
      try {
        await startMicTest(microphoneId);
      } catch (e) {
        // The mic failed to open (busy / unplugged / denied). Don't leave a silent dead meter
        // with the button stuck on Stop — end the test (cleanup stops + unlistens).
        console.error("mic test failed to start:", e);
        if (active) {
          setMicWarming(false);
          setTesting(false);
        }
      }
    })();
    return () => {
      active = false;
      clearTimeout(warmTimer);
      clearTimeout(maxTimer);
      unlisten?.();
      void stopMicTest().catch(() => {});
      setLevel(0);
      setMicWarming(false);
    };
  }, [testing, microphoneId]);

  // Clear "playing" when the replay finishes — Rust emits this once the current
  // playback drains (and wasn't superseded). The duration-based timer in replay()
  // is just a safety net in case the event is missed.
  useEffect(() => {
    let active = true;
    let un: (() => void) | undefined;
    void onMicTestPlayEnded(() => {
      if (active) setPlaying(false);
    })
      .then((u) => {
        if (active) un = u;
        else u();
      })
      .catch(() => {}); // a rejected dynamic import / listen() must not surface as an unhandled rejection
    return () => {
      active = false;
      un?.();
      if (playTimerRef.current != null) clearTimeout(playTimerRef.current);
      // Silence an in-flight replay on unmount: AudioTab unmounts on a Settings tab switch or a
      // route navigation, but the mic-test playback is a detached Rust thread (up to ~15s) that
      // only stopMicTestPlayback() halts — the test-effect cleanup's stopMicTest() doesn't touch
      // playback. Without this the clip keeps sounding with no UI to stop it. No-op when idle.
      void stopMicTestPlayback().catch(() => {});
    };
  }, []);

  // Replay the last capture. Rust guarantees a single playback at a time (a new
  // play stops the previous), so we just reflect "playing" and let the play-ended
  // event clear it, with a duration-based fallback.
  const replay = useCallback(() => {
    if (clipSecsRef.current <= 0) return;
    setPlaying(true);
    void playMicTest().catch(() => {});
    if (playTimerRef.current != null) clearTimeout(playTimerRef.current);
    playTimerRef.current = window.setTimeout(() => {
      setPlaying(false);
      playTimerRef.current = null;
    }, clipSecsRef.current * 1000 + 1000);
  }, []);

  // Stop an in-flight replay — the Replay button doubles as a Stop while it's playing.
  const stopPlayback = useCallback(() => {
    void stopMicTestPlayback().catch(() => {});
    setPlaying(false);
    if (playTimerRef.current != null) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  // Stop the test and, if it captured something, enable + play the replay. Shared by the manual
  // Stop button AND the 15s auto-stop, so both offer replay. try/finally: always flip testing off
  // even if the stop invoke rejects, so the button can't stick on "Stop".
  const stopAndReplay = useCallback(async () => {
    let secs = 0;
    try {
      secs = await stopMicTest();
    } catch (e) {
      console.error("stop mic test failed:", e); // secs stays 0 → the replay below is correctly skipped
    } finally {
      setTesting(false);
    }
    if (secs > 0.2) {
      setHasClip(true);
      clipSecsRef.current = secs;
      replay();
    }
  }, [replay]);
  stopAndReplayRef.current = stopAndReplay;

  // Test/Stop: pressing Stop replays what was just captured (a quick "did my mic
  // work?" check). The capture effect's cleanup also calls stopMicTest — harmless;
  // here we stop first so the recorded clip is final, then play it back.
  const onToggle = useCallback(async () => {
    if (!testing) {
      // Starting a test silences any lingering replay (Rust bumps the generation).
      setPlaying(false);
      if (playTimerRef.current != null) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
      setHasClip(false);
      setTesting(true);
      return;
    }
    await stopAndReplay();
  }, [testing, stopAndReplay]);

  const options = [
    { value: "default", label: "System default" },
    ...devices.map((d) => ({ value: d.id, label: d.label })),
  ];

  return (
    <Card className="px-6">
      <SettingRow title="Microphone" desc="Audio input device used for dictation.">
        <div className="flex items-center gap-2">
          <Select
            value={microphoneId ?? "default"}
            onChange={(v) => updateSettings({ microphoneId: v === "default" ? null : v })}
            options={options}
            className="w-56"
            ariaLabel="Microphone"
            // Locked during a test: switching the device mid-test re-runs the capture effect,
            // racing the old fire-and-forget stop against the new start (the late stop could tear
            // down the freshly-opened device → dead meter). Stop the test to change the mic.
            disabled={testing}
          />
          <Button variant="ghost" size="sm" title="Refresh devices" onClick={() => void refresh()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        title="Test microphone"
        desc="Open the mic and watch the input level; pressing Stop replays what it just heard."
        last
      >
        <div className="flex items-center gap-3">
          <Waveform
            level={level}
            active={testing}
            bars={16}
            tone={testing && !micWarming ? "accent" : "dim"}
            className="h-7 w-28"
          />
          {testing && micWarming && (
            <span className="animate-pulse font-mono text-[11px] text-faint">warming up…</span>
          )}
          <div className="flex items-center gap-2">
            <Button variant={testing ? "danger" : "default"} size="sm" onClick={() => void onToggle()}>
              {testing ? (
                <>
                  <Square className="size-3.5" /> Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" /> Test
                </>
              )}
            </Button>
            {hasClip && !testing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (playing ? stopPlayback() : replay())}
                title={playing ? "Stop playback" : "Replay the last test recording"}
              >
                {playing ? <Square className="size-3.5" /> : <Play className="size-3.5" />}{" "}
                {playing ? "Stop" : "Replay"}
              </Button>
            )}
          </div>
        </div>
      </SettingRow>
    </Card>
  );
}

const QUICK_LAUNCH_MAX = 6;

/** Editor for the overlay chip's quick-launch buttons: an ordered list of screens +
 *  dictation actions the user can add/reorder/remove (capped to fit the chip). */
function QuickLaunchEditor({
  items,
  onChange,
  disabled,
}: {
  items: OverlayQuickAction[];
  onChange: (v: OverlayQuickAction[]) => void;
  disabled?: boolean;
}) {
  const [pick, setPick] = useState("");
  const used = new Set(items.map((e) => `${e.kind}:${e.target}`));
  const addable = [
    ...VISIBLE_SCREENS.map((s) => ({ value: `screen:${s.id}`, label: `Screen · ${s.label}` })),
    ...OVERLAY_ACTIONS.map((a) => ({ value: `action:${a.id}`, label: `Action · ${a.label}` })),
  ].filter((o) => !used.has(o.value));

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    onChange(swap(items, i, j));
  };
  const add = () => {
    if (!pick) return;
    const [kind, target] = pick.split(":");
    onChange([
      ...items,
      {
        id: crypto.randomUUID(),
        kind: kind as "screen" | "action",
        target: target as OverlayQuickAction["target"],
      },
    ]);
    setPick("");
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {items.length === 0 && (
        <div className="text-[12.5px] text-faint">No buttons yet — add screens or dictation actions below.</div>
      )}
      {items.map((e, i) => {
        const { label, icon: Icon } = quickLaunchMeta(e);
        return (
          <div
            key={e.id}
            className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2/40 px-3 py-2"
          >
            <Icon className="size-4 shrink-0 text-faint" />
            <span className="text-[13px] text-text">{label}</span>
            <span className="font-mono text-[10px] uppercase tracking-label text-faint">{e.kind}</span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" title="Move up" onClick={() => move(i, -1)} disabled={disabled || i === 0}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Move down"
                onClick={() => move(i, 1)}
                disabled={disabled || i === items.length - 1}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Remove"
                onClick={() => onChange(items.filter((x) => x.id !== e.id))}
                disabled={disabled}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
      {items.length < QUICK_LAUNCH_MAX && addable.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            className="flex-1"
            value={pick}
            onChange={setPick}
            options={[{ value: "", label: "Add a button…" }, ...addable]}
            ariaLabel="Add a quick-launch button"
            disabled={disabled}
          />
          <Button size="sm" onClick={add} disabled={disabled || !pick}>
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

/** Capture row for the global "open the quick-add window" hotkey. Reuses the shared
 *  useHotkeyCapture hook (same as the Profiles editor); conflicts are checked against
 *  the Profile chords. On Wayland the chord registers via the evdev backend; on
 *  Windows via the always-on hook backend. */
function QuickAddShortcutRow({ lowLevelActive }: { lowLevelActive: boolean }) {
  const codes = useApp((st) => st.settings.general.quickAddHotkey);
  const profiles = useApp((st) => st.profiles);
  const updateGeneral = useApp((st) => st.updateGeneral);
  const [capturing, setCapturing] = useState(false);
  const { heldCodes, warn } = useHotkeyCapture({
    capturing,
    lowLevelActive,
    others: profiles,
    selfKind: "quickadd",
    onCommit: (c) => {
      updateGeneral({ quickAddHotkey: c });
      setCapturing(false);
    },
    onCancel: () => setCapturing(false),
  });
  return (
    <div className="py-4">
      <div className="text-[14px] font-medium text-text">Quick-add shortcut</div>
      <div className="mb-3 mt-0.5 max-w-xl text-[12.5px] leading-snug text-dim">
        A global hotkey that opens the quick-add window.
        {IS_LINUX && (
          <>
            {" "}
            On Wayland this needs the evdev backend (Permissions); otherwise bind a desktop shortcut
            to <span className="font-mono text-[11px] text-faint">app --quick-add</span>.
          </>
        )}
      </div>
      <HotkeyCaptureControl
        codes={codes}
        capturing={capturing}
        heldCodes={heldCodes}
        warn={warn}
        onToggle={() => setCapturing((c) => !c)}
        onClear={() => updateGeneral({ quickAddHotkey: [] })}
      />
    </div>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<Tab>("General");
  const s = useApp((st) => st.settings);
  // The chip "off" position disables every dependent Chip-tab control; compute once (used ~27×) so
  // a row and its control can't drift out of sync.
  const chipOff = s.recording.indicatorPosition === "off";
  const updateGeneral = useApp((st) => st.updateGeneral);
  const updateRecording = useApp((st) => st.updateRecording);
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  const [evdevMsg, setEvdevMsg] = useState<string | null>(null);
  const [evdevBusy, setEvdevBusy] = useState(false);
  // A low-level backend owns the chords when evdev is enabled AND permitted (Linux) or always
  // on Windows (the hook backend) — drives whether the quick-add capture accepts modifier-only /
  // AltGr chords (else plugin validation).
  const lowLevelActive = IS_WINDOWS || (!!evdev?.permitted && s.general.evdevEnabled);

  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match the file's other chains; ignore an IPC reject
  }, [tab]);


  // Recordings folder: resolve the active path for display (custom or default), and
  // re-resolve whenever the custom selection changes.
  const customRecDir = s.recording.recordingsDir;
  const [recDirDisplay, setRecDirDisplay] = useState<string | null>(null);
  useEffect(() => {
    void recordingsDirPath(customRecDir)
      .then(setRecDirDisplay)
      .catch((e) => {
        // Don't hang forever on "resolving…" if the path lookup fails.
        console.error("resolve recordings dir:", e);
        setRecDirDisplay(customRecDir ?? "—");
      });
  }, [customRecDir]);
  const openRecDir = () =>
    void openRecordingsDir(customRecDir).catch((e) => console.error("open recordings dir:", e));
  const changeRecDir = () =>
    void pickRecordingsDir()
      .then((picked) => {
        if (picked) updateRecording({ recordingsDir: picked });
      })
      .catch((e) => console.error("pick recordings dir:", e));
  const resetRecDir = () => updateRecording({ recordingsDir: null });

  const runEvdevSetup = () => {
    setEvdevBusy(true);
    setEvdevMsg(null);
    void evdevSetup()
      .then((m) => {
        setEvdevMsg(m);
        return evdevStatus().then(setEvdev);
      })
      .catch((e) => setEvdevMsg(String(e)))
      .finally(() => setEvdevBusy(false));
  };

  return (
    <div className="mx-auto flex max-w-[880px] gap-8 px-10 py-12">
      <div className="sticky top-12 z-10 w-[150px] shrink-0 self-start">
        <h1 className="mb-5 font-display text-[22px] font-bold tracking-tight text-text">Settings</h1>
        <div className="flex flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-current={tab === t ? "page" : undefined}
              className={
                "ring-signal rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors " +
                (tab === t ? "bg-surface-2 text-text" : "text-dim hover:text-text")
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {tab === "General" && (
          <Card className="px-6">
            <SettingRow title="Launch at login" desc="Launch automatically when you sign in.">
              <Toggle checked={s.general.openAtLogin} onChange={(v) => updateGeneral({ openAtLogin: v })} />
            </SettingRow>
            <SettingRow
              title="Start minimized to tray"
              desc="When launched at login, start hidden; reach it from the system tray. Manual starts always show the window."
            >
              <Toggle
                checked={s.general.startMinimized}
                onChange={(v) => updateGeneral({ startMinimized: v })}
                disabled={!s.general.openAtLogin}
              />
            </SettingRow>
            <SettingRow
              title="Auto-insert"
              desc="When to place the transcription into the focused field. “Live” inserts each finished phrase as you speak (streaming backends; batch inserts on stop)."
            >
              <Segmented
                value={s.general.insertTiming}
                onChange={(v) => updateGeneral({ insertTiming: v })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "stop", label: "When I stop" },
                  { value: "live", label: "Live" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Insertion method"
              desc={
                s.general.insertTiming === "live"
                  ? "Clipboard paste is the most reliable. Direct typing never touches the clipboard but can struggle with some layouts. Clipboard only copies each phrase for you to paste. Live only ever appends as you speak — it never goes back to revise earlier words."
                  : "Clipboard paste is the most reliable. Direct typing never touches the clipboard but can struggle with some layouts. Clipboard only copies the text without typing — you paste it yourself."
              }
              disabled={s.general.insertTiming === "off"}
            >
              <Segmented
                value={s.general.insertMethod}
                onChange={(v) => updateGeneral({ insertMethod: v })}
                disabled={s.general.insertTiming === "off"}
                options={[
                  { value: "paste", label: "Clipboard paste" },
                  { value: "direct", label: "Direct typing" },
                  { value: "clipboard", label: "Clipboard only" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Paste shortcut"
              desc="The keys sent for “Clipboard paste”. Terminals (Konsole, kitty…) need Ctrl + Shift + V."
              disabled={s.general.insertTiming === "off" || s.general.insertMethod !== "paste"}
            >
              <Select
                value={pasteKey(s.general.pasteShortcut)}
                onChange={(v) => updateGeneral({ pasteShortcut: pasteCodes(v) })}
                options={PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                disabled={s.general.insertTiming === "off" || s.general.insertMethod !== "paste"}
              />
            </SettingRow>
            {IS_LINUX && (
              // AT-SPI-backed — the guard is inert off Linux, so don't show a dead switch there.
              <SettingRow
                title="Deep field detection"
                desc="Skip typing when the focused element isn’t a text field — the transcript goes to the clipboard instead. Uses accessibility to cover most apps including browsers and Electron (may raise their memory use); games and the desktop are never blocked."
              >
                <Toggle
                  checked={s.general.deepFieldDetection}
                  onChange={(v) => {
                    updateGeneral({ deepFieldDetection: v });
                    void setDeepFieldDetection(v).catch((e) => console.error("set deep field detection:", e));
                  }}
                />
              </SettingRow>
            )}
            <SettingRow
              title="Press Enter after"
              desc="Send a Return key once the text is inserted."
              disabled={s.general.insertTiming === "off" || s.general.insertMethod === "clipboard"}
            >
              <Toggle
                checked={s.general.autoEnter}
                onChange={(v) => updateGeneral({ autoEnter: v })}
                disabled={s.general.insertTiming === "off" || s.general.insertMethod === "clipboard"}
              />
            </SettingRow>
            <SettingRow
              title="Restore clipboard afterward"
              desc="Put your previous clipboard contents back once the paste is done."
              disabled={s.general.insertTiming === "off" || s.general.insertMethod !== "paste"}
            >
              <Toggle
                checked={s.general.restoreClipboard}
                onChange={(v) => updateGeneral({ restoreClipboard: v })}
                disabled={s.general.insertTiming === "off" || s.general.insertMethod !== "paste"}
              />
            </SettingRow>
            <SettingRow title="Sound cues" desc="A short tone when dictation starts and stops.">
              <Toggle checked={s.general.soundEffects} onChange={(v) => updateGeneral({ soundEffects: v })} />
            </SettingRow>
            <QuickAddShortcutRow lowLevelActive={lowLevelActive} />
          </Card>
        )}

        {tab === "Audio" && <AudioTab />}

        {tab === "Recording" && (
          <Card className="px-6">
            <SettingRow title="Keep audio recordings" desc="Save a .wav of each dictation locally.">
              <Toggle checked={s.recording.saveRecordings} onChange={(v) => updateRecording({ saveRecordings: v })} />
            </SettingRow>
            <SettingRow
              title="Trim silence"
              desc="Save only the parts you actually spoke (the same speech detection that drives the chip), so a long hands-free session doesn't store hours of silence."
              disabled={!s.recording.saveRecordings}
            >
              <Toggle
                checked={s.recording.trimSilence}
                disabled={!s.recording.saveRecordings}
                onChange={(v) => updateRecording({ trimSilence: v })}
              />
            </SettingRow>
            {/* Recordings folder: where saved .wav files live, plus open / relocate / reset. Its own
                block (a mono path readout + an action row) rather than a SettingRow — the path is the
                point, and three actions don't fit a row's trailing slot. */}
            <div className="border-b border-line py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-text">Recordings folder</div>
                  <div className="mt-0.5 text-[12.5px] leading-snug text-dim">
                    {customRecDir ? "A custom folder." : "The default app folder."} Saved files stay until you remove
                    them.
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" onClick={openRecDir} title="Open in your file manager">
                    <FolderOpen size={14} strokeWidth={2} />
                    Open
                  </Button>
                  <Button size="sm" onClick={changeRecDir}>
                    Change…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={resetRecDir}
                    disabled={!customRecDir}
                    title="Revert to the default location"
                  >
                    Reset
                  </Button>
                </div>
              </div>
              <div
                title={recDirDisplay ?? undefined}
                className="mt-3 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11.5px] text-dim"
              >
                {recDirDisplay ?? "resolving…"}
              </div>
            </div>
            <SettingRow
              title="Silence other apps while recording"
              desc="Mute system audio for the duration of a dictation."
            >
              <Toggle checked={s.recording.muteSystemAudio} onChange={(v) => updateRecording({ muteSystemAudio: v })} />
            </SettingRow>
            <SettingRow
              title="Auto-stop hands-free after silence"
              desc="End a hands-free (latch) session after this long with no speech, so it can't run for hours. Set to Never to keep it open until you stop it yourself."
              last
            >
              <Stepper
                ariaLabel="auto-stop hands-free after silence"
                value={s.recording.latchAutoStopMin}
                onChange={(v) => updateRecording({ latchAutoStopMin: v })}
                min={0}
                max={120}
                step={1}
                decimals={0}
                unit="min"
                zeroLabel="Never"
              />
            </SettingRow>
          </Card>
        )}

        {tab === "Chip" && (
          <Card className="px-6">
            <SectionLabel className="mb-1 mt-4">Placement</SectionLabel>
            <SettingRow title="Position" desc="Where the dictation chip sits on screen while you talk.">
              <Segmented
                value={s.recording.indicatorPosition}
                onChange={(v) => updateRecording({ indicatorPosition: v })}
                options={[
                  { value: "top", label: "Top" },
                  { value: "bottom", label: "Bottom" },
                  { value: "off", label: "Off" },
                ]}
              />
            </SettingRow>
            <SettingRow
              title="Keep chip docked"
              desc="Keep the chip on screen as a small standby dot when you're not dictating, instead of hiding it."
              disabled={chipOff}
            >
              <Toggle
                checked={s.recording.persistentDock}
                disabled={chipOff}
                onChange={(v) => updateRecording({ persistentDock: v })}
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Auto-hide</SectionLabel>
            <SettingRow
              title="Auto-hide to edge"
              desc="After sitting idle, hide the chip against the screen edge so it stops covering things — hover the edge dot to bring it back."
              disabled={chipOff}
            >
              <Toggle
                checked={s.recording.overlayPeek}
                disabled={chipOff}
                onChange={(v) => updateRecording({ overlayPeek: v })}
              />
            </SettingRow>
            <SettingRow
              title="Hide after"
              desc="How long the chip sits idle before it hides against the edge."
              disabled={!s.recording.overlayPeek || chipOff}
            >
              <Stepper
                ariaLabel="hide after"
                value={s.recording.peekTimeoutSec}
                onChange={(v) => updateRecording({ peekTimeoutSec: v })}
                min={1}
                max={600}
                step={0.5}
                decimals={1}
                unit="s"
                disabled={!s.recording.overlayPeek || chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Stay hidden while dictating"
              desc="Keep the chip hidden against the edge as a small dot even while you dictate, instead of popping out — it just changes colour and gently pulses while you speak. Hover the edge dot to reveal the transcript."
              disabled={!s.recording.overlayPeek || chipOff}
            >
              <Toggle
                checked={s.recording.peekWhileActive}
                disabled={!s.recording.overlayPeek || chipOff}
                onChange={(v) => updateRecording({ peekWhileActive: v })}
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Appearance</SectionLabel>
            <SettingRow
              title="Dim after"
              desc="How long the chip sits idle before it fades to a dim, unobtrusive opacity (a docked standby dot dims too). Set to Never to keep it full opacity."
              disabled={chipOff}
            >
              <Stepper
                ariaLabel="dim after"
                value={s.recording.dimAfterSec}
                onChange={(v) => updateRecording({ dimAfterSec: v })}
                min={0}
                max={600}
                step={0.5}
                decimals={1}
                unit="s"
                zeroLabel="Never"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Live transcript"
              desc="Show words in the chip as you speak — always, or only while you hover it (streaming backends only)."
              disabled={chipOff}
            >
              <HoverModeSegmented
                ariaLabel="Live transcript visibility"
                visibleKey="realtimePreview"
                hoverKey="realtimePreviewOnHover"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Show active profile"
              desc="Label the chip with the running profile's tag — always, or only while you hover it; hover always reveals language and mode."
              disabled={chipOff}
            >
              <HoverModeSegmented
                ariaLabel="Active-profile visibility"
                visibleKey="showProfileOnOverlay"
                hoverKey="showProfileOnHover"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Show usage on chip"
              desc="Add a tiny usage readout (today's totals) to the chip — always, or only while you hover it. Needs the faster-whisper-backend; hidden on a standard server."
              disabled={chipOff}
            >
              <HoverModeSegmented
                ariaLabel="Usage-on-chip visibility"
                visibleKey="showStatsOnOverlay"
                hoverKey="overlayStatsOnHover"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Chip metric"
              desc="Which usage figure the chip shows."
              disabled={chipOff || !s.recording.showStatsOnOverlay}
            >
              <Select
                value={s.recording.overlayStatsMetric}
                onChange={(v) => updateRecording({ overlayStatsMetric: v })}
                options={[
                  { value: "words", label: "Words today" },
                  { value: "audio", label: "Minutes today" },
                  { value: "both", label: "Words + minutes" },
                ]}
                disabled={chipOff || !s.recording.showStatsOnOverlay}
              />
            </SettingRow>
            <SettingRow
              title="Show injection target"
              desc="Show which app dictation is typing into (→ app) on the chip — always, or only while you hover it — and warn when it isn't a text field."
              disabled={chipOff}
            >
              <HoverModeSegmented
                ariaLabel="Injection-target visibility"
                visibleKey="showTargetOnOverlay"
                hoverKey="showTargetOnHover"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title="Only while speaking"
              desc="Show the injection target only while you're actively dictating — hide it when armed but silent, so it doesn't flicker as you move between windows."
              disabled={
                chipOff ||
                !s.recording.showTargetOnOverlay ||
                s.recording.showTargetOnHover
              }
            >
              <Toggle
                checked={s.recording.showTargetOnlySpeaking}
                onChange={(v) => updateRecording({ showTargetOnlySpeaking: v })}
                disabled={
                  chipOff ||
                  !s.recording.showTargetOnOverlay ||
                  s.recording.showTargetOnHover
                }
              />
            </SettingRow>

            <SectionLabel className="mb-1 mt-7">Interaction</SectionLabel>
            <SettingRow
              title="Hover reveal delay"
              desc="How long you hover the chip before it expands to show language / mode and the quick-launch buttons."
              disabled={chipOff}
            >
              <Stepper
                ariaLabel="hover reveal delay"
                value={s.recording.hoverRevealMs}
                onChange={(v) => updateRecording({ hoverRevealMs: v })}
                min={0}
                max={3000}
                step={50}
                unit="ms"
                zeroLabel="Instant"
                disabled={chipOff}
              />
            </SettingRow>
            <div className="py-4">
              <div
                className={cn(
                  "text-[14px] font-medium text-text",
                  chipOff && "opacity-50",
                )}
              >
                Quick-launch buttons
              </div>
              <div
                className={cn(
                  "mb-3 mt-0.5 text-[12.5px] leading-snug text-dim",
                  chipOff && "opacity-50",
                )}
              >
                Icon buttons shown on the idle chip when you hover it — jump to a screen or run a dictation action.
              </div>
              <QuickLaunchEditor
                items={s.recording.quickLaunch ?? []}
                onChange={(v) => updateRecording({ quickLaunch: v })}
                disabled={chipOff}
              />
            </div>
          </Card>
        )}

        {tab === "Sync" && <SyncTab />}

        {tab === "Permissions" && (
          <Card className="px-6">
            <SettingRow title="Microphone access" desc="Required to capture your voice." last={!IS_LINUX}>
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ok">
                <StatusDot tone="ok" /> Granted
              </span>
            </SettingRow>
            {IS_LINUX && (
              // The evdev backend can never exist off Linux (/dev/input) — hide, don't dead-switch.
              <>
                <SettingRow
                  title="Hardware hotkeys (evdev)"
                  desc="Reliable hold-to-talk + left/right modifiers + AltGr on Wayland by reading /dev/input. Reads all keyboard input — strictly opt-in, and needs the 'input' group."
                  last
                >
                  {evdev && !evdev.available ? (
                    <span className="text-[12.5px] text-faint">Unavailable</span>
                  ) : evdev && evdev.permitted ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-dim">{s.general.evdevEnabled ? "On" : "Off"}</span>
                      <Toggle
                        ariaLabel="Hardware hotkeys (evdev)"
                        checked={s.general.evdevEnabled}
                        onChange={(v) => updateGeneral({ evdevEnabled: v })}
                      />
                    </div>
                  ) : (
                    <Button variant="default" size="sm" onClick={runEvdevSetup} disabled={evdevBusy}>
                      <Mic className="size-4" /> {evdevBusy ? "Authorizing…" : "Set up"}
                    </Button>
                  )}
                </SettingRow>
                {evdevMsg && <div className="px-1 pt-3 text-[12px] text-dim">{evdevMsg}</div>}
                {evdev && evdev.permitted && (
                  <div className="px-1 pt-3 text-[12px] text-faint">
                    Profiles using AltGr or a specific left/right modifier only fire while this is on.
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        <div className="mt-5 flex items-center gap-2 px-1 font-mono text-[11px] text-faint">
          <Check className="size-3.5 text-ok" /> changes apply immediately
        </div>
      </div>
    </div>
  );
}
