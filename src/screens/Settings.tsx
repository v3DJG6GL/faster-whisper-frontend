import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Mic, Check, FolderOpen, Settings as SettingsIcon } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, SectionLabel, Select, SettingRow, Stepper, StatusDot, Toggle } from "@/components/ui";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
import { dropPendingWrites, loadHistory } from "@/lib/transcript/transcriptHistory";
import { forgetRecord } from "@/lib/transcribeRun";
import {
  transcriptStoreStats,
  deleteAllDictations,
  clearFileTranscriptions,
  removeTranscriptMedia,
  type TranscriptStoreStats,
  evdevStatus,
  evdevSetup,
  setDeepFieldDetection,
  audioBasePref,
  audioDirPath,
  openAudioDir,
  moveAudioBase,
  pickRecordingsDir,
  type EvdevStatus,
} from "@/lib/api";
import { PASTE_PRESETS, pasteKey, pasteCodes } from "@/lib/paste";
import { METHOD_OPTIONS } from "@/lib/dictation/insertion";
// Row titles come from the settings manifest — the single source both this
// screen and the Sync list render from, so their labels can never drift.
import { SETTING } from "@/lib/settingsManifest";
import { SyncTab } from "@/components/sync/SettingsSync";
import {
  DICTATION_RETENTION_OPTIONS,
  HISTORY_RETENTION_OPTIONS,
  withCurrentDay,
} from "@/lib/retentionOptions";
import { AppearanceRows } from "@/components/settings/AppearanceRows";
import { AudioTab } from "@/components/settings/AudioTab";
import { HoverModeSegmented } from "@/components/settings/HoverModeSegmented";
import { LoggingSection } from "@/components/settings/LoggingSection";
import { QuickLaunchEditor } from "@/components/settings/QuickLaunchEditor";

/** "1.2 GB" / "84 MB" for the audio-copy usage readout. */
function fmtBytes(n: number): string {
  if (n <= 0) return "0 KB"; // the floor below is for a sub-512-byte FILE, never for nothing
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const TABS = ["General", "Appearance", "Audio", "Dictation", "Recording & history", "Chip", "Sync", "Permissions"] as const;

/** The audio store's per-type identity: subfolder, legend label, and the hue
 *  shared by the split bar, its legend and the subfolder chips. */
const AUDIO_STORE_TYPES = [
  { key: "dict", sub: "dictations/", label: "dictations",
    color: "#d9a45b", bytesKey: "recordingsBytes", filesKey: "recordingsFiles" },
  { key: "files", sub: "files/", label: "file transcriptions",
    color: "var(--c-ok)", bytesKey: "fileMediaBytes", filesKey: "fileMediaFiles" },
  { key: "links", sub: "links/", label: "link transcriptions",
    color: "#6faed9", bytesKey: "linkMediaBytes", filesKey: "linkMediaFiles" },
  { key: "video", sub: "video/", label: "link videos",
    color: "#c68fb4", bytesKey: "videoMediaBytes", filesKey: "videoMediaFiles" },
] as const satisfies readonly {
  key: string; sub: string; label: string; color: string;
  bytesKey: keyof TranscriptStoreStats; filesKey: keyof TranscriptStoreStats;
}[];
type Tab = (typeof TABS)[number];






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
  // Takes the base to measure: the copy `changeRecDir`/`resetRecDir` close over is built
  // from the PRE-move base, so calling it bare after a move measured the folder the audio
  // had just left (all zeros) and could settle after the effect's correct read.
  const refreshStoreStats = useCallback(
    (base: string | null = basePref) => {
      void transcriptStoreStats(base)
        .then(setStoreStats)
        .catch(() => {});
    },
    [basePref],
  );
  useEffect(() => {
    if (tab === "Recording & history") refreshStoreStats();
  }, [tab, refreshStoreStats]);
  // Inline two-step confirmation for the destructive store actions — the
  // confirm names the exact count/size (never a bare "are you sure").
  const [confirming, setConfirming] = useState<null | "dict" | "files" | "links" | "video" | "clear">(null);
  const [storeMsg, setStoreMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const dirBusyRef = useRef(false);
  // Both die with the tab that owns them: an armed "Delete 214 dictations" confirm must not
  // survive a trip to another tab, and a stale "Removed N files." must not greet the next visit.
  useEffect(() => {
    setConfirming(null);
    setStoreMsg(null);
  }, [tab]);
  const runStoreAction = (kind: "dict" | "files" | "links" | "video" | "clear") => {
    if (dirBusyRef.current) return;
    // Nothing parked may land after the wipe: a coalesced record write, an 800 ms edit
    // debounce or a chunk merge otherwise re-created a JSON file Rust just removed.
    // Only the kinds that delete record JSONs; "files"/"links" empty a media folder and must
    // not drop an unrelated edit debounce. The workbench registry holds file/URL transcripts,
    // which only "clear" removes — forgetting it on "dict" closed an open transcript for nothing.
    if (kind === "dict" || kind === "clear") dropPendingWrites();
    if (kind === "clear") forgetRecord(null);
    const done = (n: number, what: string) => {
      setStoreMsg({ text: `Removed ${n} ${what}.` });
      setConfirming(null);
      refreshStoreStats();
      void loadHistory(true).catch(() => {});
    };
    const fail = (e: unknown) => {
      setConfirming(null);
      setStoreMsg({ text: safeDisplayText(String(e), 200), error: true });
    };
    if (kind === "dict") {
      void deleteAllDictations(basePref)
        .then((n) => done(n, "dictation file(s)"))
        .catch(fail);
    } else if (kind === "files") {
      void removeTranscriptMedia("file", basePref)
        .then((n) => done(n, "audio cop(y/ies)"))
        .catch(fail);
    } else if (kind === "links") {
      void removeTranscriptMedia("url", basePref)
        .then((n) => done(n, "downloaded file(s)"))
        .catch(fail);
    } else if (kind === "video") {
      void removeTranscriptMedia("video", basePref)
        .then((n) => done(n, "video file(s)"))
        .catch(fail);
    } else {
      void clearFileTranscriptions(basePref)
        .then((n) => done(n, "transcript(s)"))
        .catch(fail);
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
    // Change… then Reset race two lookups; only the latest may land.
    let live = true;
    void audioDirPath(basePref)
      .then((p) => {
        if (live) setRecDirDisplay(p);
      })
      .catch((e) => {
        // Don't hang forever on "resolving…" if the path lookup fails.
        console.error("resolve audio dir:", e);
        if (live) setRecDirDisplay(basePref ?? "—");
      });
    return () => {
      live = false;
    };
  }, [basePref]);
  const openRecDir = () =>
    void openAudioDir(basePref).catch((e) => console.error("open audio dir:", e));
  // `dirBusy` gates every folder button while a move runs: the move walks every audio
  // file and can take minutes, and a second click (Reset during a Change) started a
  // concurrent move over the same folders with the same stale `current`.
  const changeRecDir = () =>
    void pickRecordingsDir()
      .then(async (picked) => {
        if (!picked || dirBusyRef.current) return;
        dirBusyRef.current = true;
        setDirBusy(true);
        try {
          // A coalesced record write captured BEFORE the move would land after it and put
          // the pre-move paths straight back on disk — drop it, don't flush it.
          dropPendingWrites();
          await moveAudioBase(basePref, picked);
          updateRecording({ audioBaseDir: picked });
          refreshStoreStats(picked);
          // Rust rewrote every record's mediaPath/sourcePath on disk; the load-once
          // mirror still holds the pre-move paths — and would write them back on edit.
          // The workbench registry holds them too (an overlay edit persists through it).
          forgetRecord(null);
          void loadHistory(true).catch(() => {});
        } finally {
          dirBusyRef.current = false;
          setDirBusy(false);
        }
      })
      .catch((e) => setStoreMsg({ text: `Could not move the audio folder: ${safeDisplayText(String(e), 200)}`, error: true }));
  const resetRecDir = () => {
    if (dirBusyRef.current) return;
    dirBusyRef.current = true;
    setDirBusy(true);
    dropPendingWrites();
    void moveAudioBase(basePref, null)
      .then(() => {
        updateRecording({ audioBaseDir: null, recordingsDir: null });
        refreshStoreStats(null);
        forgetRecord(null);
        void loadHistory(true).catch(() => {});
      })
      .catch((e) => setStoreMsg({ text: `Could not move the audio folder: ${safeDisplayText(String(e), 200)}`, error: true }))
      .finally(() => { dirBusyRef.current = false; setDirBusy(false); });
  };

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
    <div className="flex gap-8 px-[var(--page-pad)] pb-12 pt-6">
      <div className="sticky top-6 z-10 w-[220px] shrink-0 self-start">
        <div className="font-mono text-[11px] uppercase tracking-label text-accent">{screenEyebrow("settings")}</div>
        <h1 className="mb-5 mt-2 flex items-center gap-2.5 font-display text-[30px] font-bold tracking-tight text-text"><SettingsIcon className="size-7 text-accent" aria-hidden />{screenTitle("settings")}</h1>
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
              disabled={!s.general.openAtLogin}
              disabledReason={`Only applies to launches at login. Turn on “${SETTING.openAtLogin.label}” to use this.`}
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

        {tab === "Appearance" && (
          <Card className="px-6">
            <AppearanceRows />
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
              desc="Put your previous clipboard contents back once the paste is done. Skipped inside remote-desktop clients (mstsc, Citrix, AnyDesk…) and apps an App rule marks as remote desktop, where the clipboard reaches the remote host asynchronously and a restore can be what the remote actually pastes."
              disabled={s.general.insertMethod !== "paste"}
              disabledReason={`Only “Clipboard paste” replaces your clipboard, so only it has anything to put back. Set ${SETTING.insertMethod.label} to Clipboard paste to use this.`}
            >
              <Toggle
                checked={s.general.restoreClipboard}
                onChange={(v) => updateGeneral({ restoreClipboard: v })}
                disabled={s.general.insertMethod !== "paste"}
              />
            </SettingRow>
            {/* Not gated on the insertion method: "Clipboard only", the no-text-field divert and
                the recovery writes all put the transcript on the clipboard too. Rust reads the
                saved value (no IPC argument), so every one of those paths obeys it. The copy
                differs per OS because the mechanism does — Windows has real per-write flags,
                elsewhere it is a hint a clipboard manager may or may not honour. */}
            <SettingRow
              title={SETTING.excludeFromClipboardHistory.label}
              desc={
                IS_WINDOWS
                  ? "Dictated text stays out of Clipboard history (Win+V) and isn’t uploaded by the cloud clipboard. Clipboard restores are always kept out."
                  : "Dictated text is marked so clipboard managers that honour the hint (Klipper and others) don’t keep it."
              }
              last
            >
              <Toggle
                checked={s.general.excludeFromClipboardHistory}
                onChange={(v) => updateGeneral({ excludeFromClipboardHistory: v })}
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
                  <Button size="sm" onClick={openRecDir} disabled={dirBusy} title="Open in your file manager">
                    <FolderOpen size={14} strokeWidth={2} />
                    Open
                  </Button>
                  <Button size="sm" onClick={changeRecDir} disabled={dirBusy}>
                    {dirBusy ? "Moving…" : "Change…"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={resetRecDir}
                    disabled={dirBusy || !basePref}
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
              desc="Each dictation appears on the History screen — its text, target app, and its audio (below), on this machine only. Turning this off also deletes the stored entries."
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
                disabledReason={`There is no stored audio to trim. Turn on “${SETTING.keepDictationAudio.label}” to use this.`}
              >
                <Toggle
                  checked={s.recording.trimSilence}
                  disabled={!s.recording.saveRecordings}
                  onChange={(v) => updateRecording({ trimSilence: v })}
                />
              </SettingRow>
            </div>
            <SettingRow
              title={SETTING.reportTargetApp.label}
              desc="Sends the program name — never the window title — with each dictation so Statistics can show where you dictate. Off keeps that to yourself."
            >
              <Toggle
                checked={s.recording.reportTargetApp ?? true}
                onChange={(v) => updateRecording({ reportTargetApp: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.dictationRetention.label}
              desc="One clock for each dictation — text and audio leave together. Dictations are usually typed into their target and done; a short window is plenty. Old ones are removed on launch and whenever you change this."
              disabled={dictOff}
              disabledReason={`Nothing is kept, so there is nothing to expire. Turn on “${SETTING.keepDictationHistory.label}” or “${SETTING.keepDictationAudio.label}” to set a clock.`}
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
                options={withCurrentDay(DICTATION_RETENTION_OPTIONS, dictDays)}
              />
            </SettingRow>

            <SettingRow
              title="Delete all dictations"
              desc={`Removes all ${storeStats?.dictationCount ?? 0} stored dictations and their audio. The retention clock stays as set.`}
              last
            >
              {confirming === "dict" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("dict")}>
                    Delete {storeStats?.dictationCount ?? 0} dictations
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
              title={SETTING.keepUrlVideoCopies.label}
              desc="Fetch a link's video beside the audio on every link run, ready to export with its subtitles (video/ in the audio folder). Off: the video is fetched only when you export it. The link card can override this per link."
            >
              <Toggle
                checked={s.transcribe?.keepUrlVideoCopies ?? true}
                onChange={(v) => updateTranscribe({ keepUrlVideoCopies: v })}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.urlVideoQuality.label}
              desc="Best available, or the largest size the site offers up to this height. Bigger sizes mean larger files; the server's size limit still applies."
            >
              <Select
                value={s.transcribe?.urlVideoMaxHeight == null ? "best" : String(s.transcribe.urlVideoMaxHeight)}
                onChange={(v) =>
                  updateTranscribe({ urlVideoMaxHeight: v === "best" ? null : Number(v) })
                }
                ariaLabel={SETTING.urlVideoQuality.label}
                options={[
                  { value: "best", label: "Best available" },
                  { value: "2160", label: "Up to 2160p (4K)" },
                  { value: "1440", label: "Up to 1440p" },
                  { value: "1080", label: "Up to 1080p" },
                  { value: "720", label: "Up to 720p" },
                  { value: "480", label: "Up to 480p" },
                  { value: "360", label: "Up to 360p" },
                ]}
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
                options={withCurrentDay(
                  HISTORY_RETENTION_OPTIONS,
                  s.transcribe?.historyRetentionDays ?? 0,
                )}
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
              title="Delete videos from link transcriptions"
              desc={`Frees ${storeStats ? fmtBytes(storeStats.videoMediaBytes) : "0 KB"}. Transcripts and audio stay; a video can be fetched again from its link when you export.`}
            >
              {confirming === "video" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("video")}>
                    Delete {storeStats?.videoMediaFiles ?? 0} files
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
                    setConfirming("video");
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
              <div className={`py-2 text-[12px] ${storeMsg.error ? "text-warn" : "text-dim"}`}>{storeMsg.text}</div>
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
              title={SETTING.chipSize.label}
              desc="Scales the whole chip: pill, text, buttons and dot. The chip comes out of hiding while you adjust it, so you see the result."
              disabled={chipOff}
            >
              {/* Stored as a factor (1 = 100%); shown as a percentage. */}
              <Stepper
                ariaLabel="chip size"
                value={Math.round((s.recording.chipScale ?? 1) * 100)}
                onChange={(v) => updateRecording({ chipScale: v / 100 })}
                min={75}
                max={200}
                step={5}
                unit="%"
                disabled={chipOff}
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
            <SettingRow
              title={SETTING.dotSize.label}
              desc="Makes the dot larger while the chip is hidden at the screen edge. Chip size does not affect it, and the dot inside the chip keeps its normal size. The chip stays hidden while you adjust it, so you see the result."
              disabled={chipOff}
            >
              <Stepper
                ariaLabel="dot size"
                value={Math.round((s.recording.dotScale ?? 1) * 100)}
                onChange={(v) => updateRecording({ dotScale: v / 100 })}
                min={100}
                max={300}
                step={25}
                unit="%"
                disabled={chipOff}
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
