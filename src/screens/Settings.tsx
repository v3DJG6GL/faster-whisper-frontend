import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Mic, Check, Play, RefreshCw, Square, ArrowUp, ArrowDown, Trash2, Plus, FolderOpen } from "lucide-react";
import { useApp } from "@/lib/store";
import { swap } from "@/lib/arr";
import { Button, Card, Segmented, SectionLabel, Select, SettingRow, Stepper, StatusDot, Toggle } from "@/components/ui";
import { Waveform } from "@/components/Waveform";
import { VISIBLE_SCREENS, OVERLAY_ACTIONS, quickLaunchMeta } from "@/lib/screens";
import { IS_LINUX } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
import { loadHistory } from "@/lib/transcriptHistory";
import {
  transcriptStoreStats,
  deleteAllDictations,
  clearFileTranscriptions,
  removeTranscriptMedia,
  type TranscriptStoreStats,
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
  audioBasePref,
  audioDirPath,
  openAudioDir,
  moveAudioBase,
  pickRecordingsDir,
  logFolderPath,
  openLogFolder,
  type EvdevStatus,
} from "@/lib/api";
import type { AudioDevice, OverlayQuickAction, RecordingSettings } from "@/lib/types";
import { PASTE_PRESETS, pasteKey, pasteCodes } from "@/lib/paste";
import { METHOD_OPTIONS } from "@/components/DictationFields";
// Row titles come from the settings manifest — the single source both this
// screen and the Sync list render from, so their labels can never drift.
import { SETTING } from "@/lib/settingsManifest";
import { SyncTab } from "@/screens/SettingsSync";

/** "1.2 GB" / "84 MB" for the audio-copy usage readout. */
function fmtBytes(n: number): string {
  if (n <= 0) return "0 KB"; // the floor below is for a sub-512-byte FILE, never for nothing
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const TABS = ["General", "Audio", "Dictation", "Recording & history", "Chip", "Sync", "Permissions"] as const;

/** The audio store's per-type identity: subfolder, legend label, and the hue
 *  shared by the split bar, its legend and the subfolder chips. */
const AUDIO_STORE_TYPES = [
  { key: "dict", sub: "dictations/", label: "dictations",
    color: "#d9a45b", bytesKey: "recordingsBytes", filesKey: "recordingsFiles" },
  { key: "files", sub: "files/", label: "file transcriptions",
    color: "var(--c-ok)", bytesKey: "fileMediaBytes", filesKey: "fileMediaFiles" },
  { key: "links", sub: "links/", label: "link transcriptions",
    color: "#6faed9", bytesKey: "linkMediaBytes", filesKey: "linkMediaFiles" },
] as const satisfies readonly {
  key: string; sub: string; label: string; color: string;
  bytesKey: keyof TranscriptStoreStats; filesKey: keyof TranscriptStoreStats;
}[];
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
            {/* `kind` is blob-authored: `withSettingsDefaults` type-checks it as a string but
                bounds neither its length nor its character set, and Rust round-trips the block
                without interpreting it. Its row-sibling `label` is already defanged by
                `quickLaunchMeta`; this one is rendered as a child two elements over. */}
            <span className="shrink-0 truncate font-mono text-[10px] uppercase tracking-label text-faint">
              {safeDisplayText(e.kind, 24)}
            </span>
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

/** Settings → General → Logging: the in-app log viewer's knobs. Level changes
 *  apply live (the Rust filter reloads on config save); `RUST_LOG` overrides
 *  the level control when set at launch. */
function LoggingSection() {
  const logging = useApp((s) => s.settings.logging);
  const updateLogging = useApp((s) => s.updateLogging);
  const navigate = useNavigate();
  const [folder, setFolder] = useState<string | null>(null);
  const logDir = logging?.logDir ?? null;
  useEffect(() => {
    void logFolderPath(logDir).then(setFolder);
  }, [logDir]);

  return (
    <>
      <SectionLabel className="mb-1 mt-4">Logging</SectionLabel>
      <SettingRow
        title={SETTING.logLevel.label}
        desc="How much detail is captured — lower levels aren’t recorded at all. Debug helps when reporting a problem; Info is right for every day. A RUST_LOG environment variable overrides this."
      >
        <Segmented
          value={logging?.logLevel ?? "info"}
          onChange={(v) => updateLogging({ logLevel: v })}
          ariaLabel="Log level"
          options={[
            { value: "error", label: "Errors" },
            { value: "warn", label: "Warnings" },
            { value: "info", label: "Info" },
            { value: "debug", label: "Debug" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title={SETTING.logRetention.label}
        desc="Log files older than this are deleted on startup. The current session is always kept."
      >
        <Select
          value={String(logging?.keepDays ?? 30)}
          onChange={(v) => updateLogging({ keepDays: Number(v) })}
          ariaLabel="Keep log files"
          options={[
            { value: "7", label: "7 days" },
            { value: "14", label: "14 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "180", label: "180 days" },
            { value: "0", label: "Keep forever" },
          ]}
        />
      </SettingRow>
      <SettingRow
        title={SETTING.logsInSidebar.label}
        desc="Hidden, the page stays reachable from the button below — and from failure notices, which still appear."
      >
        <Toggle
          checked={logging?.showInSidebar ?? true}
          onChange={(v) => updateLogging({ showInSidebar: v })}
        />
      </SettingRow>
      <SettingRow title="Logs page" desc="Opens the console — works whether or not the sidebar entry is shown.">
        <Button size="sm" variant="accent" onClick={() => navigate("/logs")}>
          Open logs
        </Button>
      </SettingRow>
      <SettingRow
        title={SETTING.logFolder.label}
        desc={folder ? safeDisplayText(folder, 120) : "One file per app session."}
        last
      >
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void openLogFolder(logDir).catch(() => {})}>
            Open folder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void pickRecordingsDir().then((picked) => {
                if (picked) updateLogging({ logDir: picked });
              })
            }
          >
            Change…
          </Button>
          {logDir && (
            <Button size="sm" variant="ghost" onClick={() => updateLogging({ logDir: null })}>
              Reset
            </Button>
          )}
        </div>
      </SettingRow>
    </>
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
  const updateSettings = useApp((st) => st.updateSettings);
  /** History settings ride the opaque settings.transcribe blob (merge-patch). */
  const updateTranscribe = (patch: Partial<NonNullable<typeof s.transcribe>>) =>
    updateSettings({ transcribe: { ...s.transcribe, ...patch } });
  // The one audio base folder (audioBaseDir, legacy recordingsDir fallback).
  const basePref = audioBasePref(s.recording);
  // Per-type storage readout (the folder row's bar + the action rows' counts).
  const [storeStats, setStoreStats] = useState<TranscriptStoreStats | null>(null);
  const refreshStoreStats = useCallback(() => {
    void transcriptStoreStats(basePref)
      .then(setStoreStats)
      .catch(() => {});
  }, [basePref]);
  useEffect(() => {
    if (tab === "Recording & history") refreshStoreStats();
  }, [tab, refreshStoreStats]);
  // Inline two-step confirmation for the destructive store actions — the
  // confirm names the exact count/size (never a bare "are you sure").
  const [confirming, setConfirming] = useState<null | "dict" | "files" | "links" | "clear">(null);
  const [storeMsg, setStoreMsg] = useState<string | null>(null);
  const runStoreAction = (kind: "dict" | "files" | "links" | "clear") => {
    const done = (n: number, what: string) => {
      setStoreMsg(`Removed ${n} ${what}.`);
      setConfirming(null);
      refreshStoreStats();
      void loadHistory(true).catch(() => {});
    };
    if (kind === "dict") {
      void deleteAllDictations(basePref)
        .then((n) => done(n, "dictation file(s)"))
        .catch((e) => setStoreMsg(String(e)));
    } else if (kind === "files") {
      void removeTranscriptMedia("file", basePref)
        .then((n) => done(n, "audio cop(y/ies)"))
        .catch((e) => setStoreMsg(String(e)));
    } else if (kind === "links") {
      void removeTranscriptMedia("url", basePref)
        .then((n) => done(n, "downloaded file(s)"))
        .catch((e) => setStoreMsg(String(e)));
    } else {
      void clearFileTranscriptions(basePref)
        .then((n) => done(n, "transcript(s)"))
        .catch((e) => setStoreMsg(String(e)));
    }
  };
  // One dictation clock for text AND audio: display the stricter of the two
  // legacy values (the keys keep syncing separately for older builds), write
  // both on change.
  const dictDaysA = s.recording.recordingsRetentionDays ?? 0;
  const dictDaysB = s.transcribe?.dictationRetentionDays ?? 7;
  const dictDays =
    dictDaysA === 0 ? dictDaysB : dictDaysB === 0 ? dictDaysA : Math.min(dictDaysA, dictDaysB);
  const dictOff = s.transcribe?.keepDictationHistory === false && !s.recording.saveRecordings;
  const [evdev, setEvdev] = useState<EvdevStatus | null>(null);
  const [evdevMsg, setEvdevMsg] = useState<string | null>(null);
  const [evdevBusy, setEvdevBusy] = useState(false);

  // Deep link: /settings?tab=<name> opens straight onto that tab (the History
  // screen's retention readout uses it). Consumed once, like Profiles ?edit.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t && (TABS as readonly string[]).includes(t)) {
      setTab(t as Tab);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    void evdevStatus().then(setEvdev).catch(() => {}); // match the file's other chains; ignore an IPC reject
  }, [tab]);


  // Audio base folder: resolve the active path for display (custom or
  // default), re-resolving when the preference changes. Change/Reset MOVE the
  // whole store first and persist the setting only on success.
  const [recDirDisplay, setRecDirDisplay] = useState<string | null>(null);
  useEffect(() => {
    void audioDirPath(basePref)
      .then(setRecDirDisplay)
      .catch((e) => {
        // Don't hang forever on "resolving…" if the path lookup fails.
        console.error("resolve audio dir:", e);
        setRecDirDisplay(basePref ?? "—");
      });
  }, [basePref]);
  const openRecDir = () =>
    void openAudioDir(basePref).catch((e) => console.error("open audio dir:", e));
  const changeRecDir = () =>
    void pickRecordingsDir()
      .then(async (picked) => {
        if (!picked) return;
        await moveAudioBase(basePref, picked);
        updateRecording({ audioBaseDir: picked });
        refreshStoreStats();
        // Rust rewrote every record's mediaPath/sourcePath on disk; the load-once
        // mirror still holds the pre-move paths — and would write them back on edit.
        void loadHistory(true).catch(() => {});
      })
      .catch((e) => setStoreMsg(`Could not move the audio folder: ${e}`));
  const resetRecDir = () =>
    void moveAudioBase(basePref, null)
      .then(() => {
        updateRecording({ audioBaseDir: null, recordingsDir: null });
        refreshStoreStats();
        void loadHistory(true).catch(() => {});
      })
      .catch((e) => setStoreMsg(`Could not move the audio folder: ${e}`));

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
    // Not a centered `.page`: the section nav is a RAIL, and a rail belongs
    // against the sidebar it continues. Centering the pair left a wide gap
    // between the two menus that read as one piece of chrome. So the rail sits
    // at the page padding and the content column takes the rest, capped at the
    // form width so setting rows never stretch past a comfortable measure.
    <div className="flex gap-8 px-[var(--page-pad)] py-12">
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

      <div className="min-w-0 max-w-[var(--w-form)] flex-1">
        {tab === "General" && (
          <Card className="px-6">
            <SettingRow title={SETTING.openAtLogin.label} desc="Launch automatically when you sign in.">
              <Toggle checked={s.general.openAtLogin} onChange={(v) => updateGeneral({ openAtLogin: v })} />
            </SettingRow>
            <SettingRow
              title={SETTING.startMinimized.label}
              desc="When launched at login, start hidden; reach it from the system tray. Manual starts always show the window."
            >
              <Toggle
                checked={s.general.startMinimized}
                onChange={(v) => updateGeneral({ startMinimized: v })}
                disabled={!s.general.openAtLogin}
              />
            </SettingRow>
            <SettingRow title={SETTING.soundCues.label} desc="A short tone when dictation starts and stops.">
              <Toggle checked={s.general.soundEffects} onChange={(v) => updateGeneral({ soundEffects: v })} />
            </SettingRow>
            {/* The quick-add shortcut moved to the Dictionary screen, next to the pinned list. */}
            <LoggingSection />
          </Card>
        )}

        {tab === "Audio" && <AudioTab />}

        {tab === "Dictation" && (
          <Card className="px-6">
            {/* The insertion chain, moved here from General — which mixed launch behaviour
                with what happens to your words. These are the GLOBAL defaults: a Profile
                overrides them for one task, and an App rule overrides both for one target
                app (see resolveInjectionTarget for the order). */}
            <SectionLabel className="mb-1 mt-4">Insertion</SectionLabel>
            <SettingRow
              title={SETTING.typeAsISpeak.label}
              desc="Insert each phrase as you talk, instead of the whole transcript when the session ends. Only applies to hands-free profiles on a streaming backend — push-to-talk always inserts on release, and batch after transcribing. A profile can override this."
            >
              <Toggle
                checked={s.general.typeAsISpeak}
                onChange={(v) => updateGeneral({ typeAsISpeak: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.insertMethod.label}
              desc="Clipboard paste is the most reliable. Direct typing never touches the clipboard but can struggle with some layouts. Clipboard only copies the text without typing — you paste it yourself."
            >
              <Segmented
                ariaLabel={SETTING.insertMethod.label}
                value={s.general.insertMethod}
                onChange={(v) => updateGeneral({ insertMethod: v })}
                options={METHOD_OPTIONS}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.pasteShortcut.label}
              desc="The keys sent for “Clipboard paste”. Terminals (Konsole, kitty…) need Ctrl + Shift + V."
              disabled={s.general.insertMethod !== "paste"}
              disabledReason={`Only used by “Clipboard paste”. Set ${SETTING.insertMethod.label} to Clipboard paste to choose a chord.`}
            >
              <Select
                value={pasteKey(s.general.pasteShortcut)}
                onChange={(v) => updateGeneral({ pasteShortcut: pasteCodes(v) })}
                options={PASTE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                disabled={s.general.insertMethod !== "paste"}
              />
            </SettingRow>
            {IS_LINUX && (
              // AT-SPI-backed — the guard is inert off Linux, so don't show a dead switch there.
              <SettingRow
                title={SETTING.deepFieldDetection.label}
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
              title={SETTING.pressEnterAfter.label}
              desc="Send a Return key once the text is inserted."
              disabled={s.general.insertMethod === "clipboard"}
              disabledReason={`Nothing is typed with “Clipboard only”, so there is no Return to send. Change ${SETTING.insertMethod.label} to send one.`}
            >
              <Toggle
                checked={s.general.autoEnter}
                onChange={(v) => updateGeneral({ autoEnter: v })}
                disabled={s.general.insertMethod === "clipboard"}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.restoreClipboard.label}
              desc="Put your previous clipboard contents back once the paste is done. Skipped inside remote-desktop clients (mstsc, Citrix, AnyDesk…), where the clipboard reaches the remote host asynchronously and a restore can be what the remote actually pastes."
              disabled={s.general.insertMethod !== "paste"}
              disabledReason={`Only “Clipboard paste” replaces your clipboard, so only it has anything to put back. Set ${SETTING.insertMethod.label} to Clipboard paste to use this.`}
              last
            >
              <Toggle
                checked={s.general.restoreClipboard}
                onChange={(v) => updateGeneral({ restoreClipboard: v })}
                disabled={s.general.insertMethod !== "paste"}
              />
            </SettingRow>

            {/* Moved from Recording & history, which mixed audio RETENTION with controls
                that only matter while a session is live. */}
            <SectionLabel className="mb-1 mt-7">While recording</SectionLabel>
            {/* PulseAudio/PipeWire-backed — `apply_mute` is a real no-op off Linux (macOS has
                neither pactl nor wpctl), so don't show a dead switch there. The setting itself
                still syncs; only the row is gated. */}
            {IS_LINUX && (
              <SettingRow
                title={SETTING.muteSystemAudio.label}
                desc="Mute other apps' audio for the duration of a dictation (PulseAudio/PipeWire desktops)."
              >
                <Toggle checked={s.recording.muteSystemAudio} onChange={(v) => updateRecording({ muteSystemAudio: v })} />
              </SettingRow>
            )}
            <SettingRow
              title={SETTING.handsFreeAutoStop.label}
              desc="End a hands-free session after this long with no speech, so it can't run for hours. Set to Never to keep it open until you stop it yourself. Push-to-talk ends on key release, so this doesn't apply to it."
              last
            >
              <Stepper
                ariaLabel="auto-stop hands-free after silence"
                value={s.recording.handsFreeAutoStopMin}
                onChange={(v) => updateRecording({ handsFreeAutoStopMin: v })}
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

        {tab === "Recording & history" && (
          <>
          <Card className="px-6 pb-2">
            {/* Grouped by SUBJECT, one retention clock per subject — see the
                design canvas ("Recording & history, whole page", rev C). */}
            <SectionLabel className="mb-1 mt-4">Audio storage</SectionLabel>
            {/* The ONE home for all stored audio, with a fixed subfolder per
                type. Its own block: header line (title + actions), then the
                full-width split bar, legend, path and subfolder chips. */}
            <div className="border-b border-line py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-text">Audio folder</div>
                  <div className="mt-0.5 text-[12.5px] leading-snug text-dim">
                    Everything the app records or copies lives here, one subfolder per type.
                    Changing it moves the existing audio along.
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
                    disabled={!basePref}
                    title="Move everything back to the default location"
                  >
                    Reset
                  </Button>
                </div>
              </div>
              {storeStats && (
                <>
                  <div className="mt-3.5 flex h-[6px] gap-0.5">
                    {AUDIO_STORE_TYPES.map((t) => {
                      const bytes = storeStats[t.bytesKey];
                      if (bytes <= 0) return null;
                      return (
                        <div
                          key={t.key}
                          className="min-w-[4px] rounded-pill"
                          style={{ flexGrow: bytes, flexBasis: 0, background: t.color }}
                        />
                      );
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-faint">
                    {AUDIO_STORE_TYPES.map((t) => (
                      <span key={t.key} className="inline-flex items-baseline gap-1.5">
                        <span
                          className="size-2 self-center rounded-[2px]"
                          style={{ background: t.color }}
                        />
                        {t.label}{" "}
                        <span className="text-text">
                          {storeStats[t.filesKey] > 0
                            ? `${fmtBytes(storeStats[t.bytesKey])} · ${storeStats[t.filesKey]}`
                            : "—"}
                        </span>
                      </span>
                    ))}
                    <span>
                      total{" "}
                      <span className="text-text">
                        {fmtBytes(
                          storeStats.recordingsBytes + storeStats.fileMediaBytes + storeStats.linkMediaBytes,
                        )}{" "}
                        · {storeStats.recordingsFiles + storeStats.fileMediaFiles + storeStats.linkMediaFiles}
                      </span>
                    </span>
                  </div>
                </>
              )}
              <div
                title={recDirDisplay ?? undefined}
                className="mt-3 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[11.5px] text-dim"
              >
                {recDirDisplay ?? "resolving…"}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {AUDIO_STORE_TYPES.map((t) => (
                  <span
                    key={t.key}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface-2 px-2.5 py-0.5 font-mono text-[11px] text-dim"
                  >
                    <span className="size-2 rounded-[2px]" style={{ background: t.color }} />
                    {t.sub}
                  </span>
                ))}
              </div>
            </div>

            <SectionLabel className="mb-1 mt-4">Dictations</SectionLabel>
            <SettingRow
              title={SETTING.keepDictationHistory.label}
              desc="Each session appears on the History screen — its text, target app, and its audio (below), on this machine only. Turning this off also deletes the stored entries."
            >
              <Toggle
                checked={s.transcribe?.keepDictationHistory ?? true}
                onChange={(v) => updateTranscribe({ keepDictationHistory: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.keepDictationAudio.label}
              desc="Keep each session's sound as a .wav next to its text, for replay from History."
            >
              <Toggle checked={s.recording.saveRecordings} onChange={(v) => updateRecording({ saveRecordings: v })} />
            </SettingRow>
            <div className="pl-6">
              <SettingRow
                title={SETTING.trimSilence.label}
                desc="Keep only the parts you actually spoke (the same speech detection that drives the chip), so a long hands-free session doesn't store hours of silence."
                disabled={!s.recording.saveRecordings}
              >
                <Toggle
                  checked={s.recording.trimSilence}
                  disabled={!s.recording.saveRecordings}
                  onChange={(v) => updateRecording({ trimSilence: v })}
                />
              </SettingRow>
            </div>
            <SettingRow
              title={SETTING.dictationRetention.label}
              desc="One clock for the whole session — text and audio leave together. Dictations are usually typed into their target and done; a short window is plenty. Old ones are removed on launch and whenever you change this."
              disabled={dictOff}
            >
              <Select
                value={String(dictDays)}
                disabled={dictOff}
                onChange={(v) => {
                  const n = Number(v);
                  updateRecording({ recordingsRetentionDays: n });
                  updateTranscribe({ dictationRetentionDays: n });
                }}
                ariaLabel="Delete dictations after"
                options={[
                  { value: "0", label: "Keep forever" },
                  { value: "1", label: "1 day" },
                  { value: "7", label: "7 days" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                ]}
              />
            </SettingRow>

            <SettingRow
              title="Delete all dictations"
              desc={`Removes all ${storeStats?.dictationCount ?? 0} stored sessions and their audio. The retention clock stays as set.`}
              last
            >
              {confirming === "dict" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("dict")}>
                    Delete {storeStats?.dictationCount ?? 0} sessions
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setStoreMsg(null);
                    setConfirming("dict");
                  }}
                >
                  Delete…
                </Button>
              )}
            </SettingRow>

            <SectionLabel className="mb-1 mt-4">Transcriptions</SectionLabel>
            <SettingRow
              title={SETTING.keepAudioCopies.label}
              desc="Keep a copy of audio you transcribe from disk, so History playback keeps working when the original moves. Turning this off keeps existing copies."
            >
              <Toggle
                checked={s.transcribe?.keepAudioCopies ?? true}
                onChange={(v) => updateTranscribe({ keepAudioCopies: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.keepUrlAudioCopies.label}
              desc="Keep the audio downloaded for a link transcription. It's the only copy — without it, the transcription can't be replayed. Turning this off keeps existing audio."
            >
              <Toggle
                checked={s.transcribe?.keepUrlAudioCopies ?? true}
                onChange={(v) => updateTranscribe({ keepUrlAudioCopies: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.transcriptionRetention.label}
              desc="Files and links alike — transcript, corrections, speaker names and the audio copy leave together. Link audio removed this way can't be re-downloaded."
            >
              <Select
                value={String(s.transcribe?.historyRetentionDays ?? 0)}
                onChange={(v) => updateTranscribe({ historyRetentionDays: Number(v) })}
                ariaLabel="Delete transcriptions after"
                options={[
                  { value: "0", label: "Keep forever" },
                  { value: "7", label: "7 days" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                  { value: "365", label: "1 year" },
                ]}
              />
            </SettingRow>

            <SettingRow
              title="Delete audio from file transcriptions"
              desc={`Frees ${storeStats ? fmtBytes(storeStats.fileMediaBytes) : "0 KB"}. Transcripts stay, and the originals on disk aren't touched — only in-app playback for moved originals is lost.`}
            >
              {confirming === "files" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("files")}>
                    Delete {storeStats?.fileMediaFiles ?? 0} files
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setStoreMsg(null);
                    setConfirming("files");
                  }}
                >
                  Delete…
                </Button>
              )}
            </SettingRow>
            <SettingRow
              title="Delete audio from link transcriptions"
              desc={`Frees ${storeStats ? fmtBytes(storeStats.linkMediaBytes) : "0 KB"}. Transcripts stay, but this audio can't be re-downloaded — playback for these link transcriptions is gone for good.`}
            >
              {confirming === "links" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("links")}>
                    Delete {storeStats?.linkMediaFiles ?? 0} files
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setStoreMsg(null);
                    setConfirming("links");
                  }}
                >
                  Delete…
                </Button>
              )}
            </SettingRow>
            <SettingRow
              title="Delete all transcriptions"
              desc={`Removes all ${storeStats?.fileCount ?? 0} file and link transcriptions, with their corrections, speaker names and stored audio.`}
              last
            >
              {confirming === "clear" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("clear")}>
                    Delete {storeStats?.fileCount ?? 0} transcripts
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setStoreMsg(null);
                    setConfirming("clear");
                  }}
                >
                  Delete…
                </Button>
              )}
            </SettingRow>
            {storeMsg && (
              <div className="py-2 text-[12px] text-dim">{storeMsg}</div>
            )}

          </Card>
          </>
        )}

        {tab === "Chip" && (
          <Card className="px-6">
            <SectionLabel className="mb-1 mt-4">Placement</SectionLabel>
            <SettingRow title={SETTING.chipPosition.label} desc="Where the dictation chip sits on screen while you talk.">
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
              title={SETTING.keepChipDocked.label}
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
              title={SETTING.autoHideToEdge.label}
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
              title={SETTING.hideAfter.label}
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
              title={SETTING.stayHiddenWhileDictating.label}
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
              title={SETTING.dimAfter.label}
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
              title={SETTING.liveTranscript.label}
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
              title={SETTING.showActiveProfile.label}
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
              title={SETTING.showTranslationRoute.label}
              desc="Show which languages dictation is being translated into (→ FR IT) on the chip — always, or only while you hover it. Shown on its own when the profile tag is off."
              disabled={chipOff}
            >
              <HoverModeSegmented
                ariaLabel="Translation-route visibility"
                visibleKey="showRouteOnOverlay"
                hoverKey="showRouteOnHover"
                disabled={chipOff}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.showUsageOnChip.label}
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
              title={SETTING.chipMetric.label}
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
              title={SETTING.showInjectionTarget.label}
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
              title={SETTING.onlyWhileSpeaking.label}
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
              title={SETTING.hoverRevealDelay.label}
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
                {SETTING.quickLaunchButtons.label}
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
