import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { Mic, Check, FolderOpen, Settings as SettingsIcon } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, Segmented, SectionLabel, Select, SettingRow, Stepper, Toggle } from "@/components/ui";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
import { fmtFull, plural } from "@/lib/format";
import { dropPendingWrites, flushRecordWrites, loadHistory, type TranscriptRecord } from "@/lib/transcript/transcriptHistory";
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
import { patchTranscribe } from "@/lib/useDisplayToggles";
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
  // The unit follows the ROUNDED value: 1023.6 MiB reads "1.0 GB", never "1024 MB".
  const mb = Math.round(n / 1024 ** 2);
  if (n >= 1024 ** 3 || mb >= 1024) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${mb} MB`;
  const kb = Math.max(1, Math.round(n / 1024));
  return kb >= 1024 ? "1 MB" : `${kb} KB`;
}

/** Link-download video height caps. A synced value outside this list (sync accepts any
 *  144–4320) is appended by `withCurrentHeight` so the Select shows the real cap instead
 *  of falling back to "Best available". */
const URL_VIDEO_QUALITY_OPTIONS = [
  { value: "best", label: "Best available" },
  { value: "2160", label: "Up to 2160p (4K)" },
  { value: "1440", label: "Up to 1440p" },
  { value: "1080", label: "Up to 1080p" },
  { value: "720", label: "Up to 720p" },
  { value: "480", label: "Up to 480p" },
  { value: "360", label: "Up to 360p" },
];
function withCurrentHeight(h: number | null | undefined) {
  if (h == null || URL_VIDEO_QUALITY_OPTIONS.some((o) => o.value === String(h))) return URL_VIDEO_QUALITY_OPTIONS;
  return [...URL_VIDEO_QUALITY_OPTIONS, { value: String(h), label: `Up to ${h}p` }];
}

const TABS = ["General", "Appearance", "Audio", "Dictation", "Recording & history", "Chip", "Sync", "Permissions"] as const;

/** The audio store's per-type identity: subfolder, legend label, and the hue
 *  shared by the split bar, its legend and the subfolder chips. */
const AUDIO_STORE_TYPES = [
  { key: "dict", sub: "dictations/", label: "dictations",
    color: "#d9a45b", bytesKey: "recordingsBytes", filesKey: "recordingsAudioFiles" },
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

// The parked writes a dictation-only wipe drops.
const isDictationRecord = (r: TranscriptRecord) => r.kind === "dictation";
// The parked writes a "Delete all transcriptions" wipe drops (Rust wipes only the top-level
// folder; dictations live in transcripts/dictation/).
const isFileStoreRecord = (r: TranscriptRecord) => r.kind !== "dictation";

// The folder-move and store-wipe guards live at module scope, not in the screen: Settings is a
// plain route that unmounts on navigation while the IPC keeps running (a move can take
// minutes), and per-mount flags came back false on return — re-enabling Change…/Reset over
// a move still in flight. The flags outlive the screen exactly as long as the IPC does.
const busy = { dir: false, store: false };
const busySubs = new Set<() => void>();
function setBusy(k: "dir" | "store", v: boolean) {
  busy[k] = v;
  busySubs.forEach((f) => f());
}
const subscribeBusy = (f: () => void) => {
  busySubs.add(f);
  return () => {
    busySubs.delete(f);
  };
};
// A failed move parks its message here for the same reason: the screen (or the tab) that
// started it may be gone when it settles, and a per-mount message was dropped or wiped by the
// tab reset — a failed or partial move of the whole store went unreported. The live mount shows
// it once the Recording & history tab is open, then clears it.
let moveError: string | null = null;
function reportMoveError(e: unknown) {
  console.error("audio folder move failed:", e);
  moveError = `Could not move the audio folder: ${safeDisplayText(String(e), 200)}`;
  busySubs.forEach((f) => f());
}






export default function Settings() {
  const [tab, setTab] = useState<Tab>("General");
  const s = useApp((st) => st.settings);
  // The chip "off" position disables every dependent Chip-tab control; compute once (used ~27×) so
  // a row and its control can't drift out of sync.
  const chipOff = s.recording.indicatorPosition === "off";
  const updateGeneral = useApp((st) => st.updateGeneral);
  const updateRecording = useApp((st) => st.updateRecording);
  /** History settings ride the opaque settings.transcribe blob (merge-patch over the live
   *  store, not this render's snapshot). */
  const updateTranscribe = patchTranscribe;
  // The one audio base folder (audioBaseDir, legacy recordingsDir fallback).
  const basePref = audioBasePref(s.recording);
  // Per-type storage readout (the folder row's bar + the action rows' counts).
  const [storeStats, setStoreStats] = useState<TranscriptStoreStats | null>(null);
  // Only the latest read may land: a slow walk started mid-operation (a mount with no stats
  // yet reads while busy) must not settle after the read the busy edge starts.
  const statsSeq = useRef(0);
  const haveStatsRef = useRef(false);
  const refreshStoreStats = useCallback(() => {
    const my = ++statsSeq.current;
    void transcriptStoreStats(basePref)
      .then((st) => {
        if (my !== statsSeq.current) return;
        haveStatsRef.current = true;
        setStoreStats(st);
      })
      .catch(() => {});
  }, [basePref]);
  const dirBusy = useSyncExternalStore(subscribeBusy, () => busy.dir);
  // One store action in flight (`busy.store`): the confirm stays mounted until it settles, and a
  // second click re-ran the wipe — that call found nothing, settled last and reported "Removed 0".
  // Its rendered mirror disables the folder buttons while a wipe runs (a move would walk the
  // folder the wipe is deleting from).
  const storeBusy = useSyncExternalStore(subscribeBusy, () => busy.store);
  // Re-read on the busy true->false edge too: a wipe or move outlives the screen, so the mount
  // that started it may be gone when it settles — this effect refreshes whichever mount is live
  // (a wipe or a failed move leaves basePref unchanged, so nothing else would re-run it). It is
  // also the one re-read after a successful move: basePref flips while busy, so the edge reads
  // the new base. A mount with no stats yet reads even while busy (else a screen opened during
  // a move or wipe showed zero counts until it ended); storeStats stays out of the deps — every
  // read sets a new object, so the effect would loop.
  useEffect(() => {
    if (tab === "Recording & history" && ((!dirBusy && !storeBusy) || !haveStatsRef.current))
      refreshStoreStats();
  }, [tab, refreshStoreStats, dirBusy, storeBusy]);
  // Inline two-step confirmation for the destructive store actions — the
  // confirm names the exact count/size (never a bare "are you sure").
  const [confirming, setConfirming] = useState<null | "dict" | "files" | "links" | "video" | "clear">(null);
  const [storeMsg, setStoreMsg] = useState<{ text: string; error?: boolean } | null>(null);
  // Both die with the tab that owns them: an armed "Delete 214 dictations" confirm must not
  // survive a trip to another tab, and a stale "Removed N files." must not greet the next visit.
  useEffect(() => {
    setConfirming(null);
    setStoreMsg(null);
  }, [tab]);
  // After the reset above, so a move that failed while away survives the trip back to the tab.
  const pendingMoveErr = useSyncExternalStore(subscribeBusy, () => moveError);
  useEffect(() => {
    if (tab === "Recording & history" && moveError) {
      setStoreMsg({ text: moveError, error: true });
      moveError = null;
    }
  }, [tab, pendingMoveErr]);
  // An action that resolves after the user left the tab must not re-set what the reset above cleared.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const runStoreAction = (kind: "dict" | "files" | "links" | "video" | "clear") => {
    if (busy.dir || busy.store) return;
    // Nothing parked may land after the wipe: a coalesced record write, an 800 ms edit
    // debounce or a chunk merge otherwise re-created a JSON file Rust just removed.
    // Only the kinds that delete record JSONs; "files"/"links" empty a media folder and must
    // not drop an unrelated edit debounce. The workbench registry holds file/URL transcripts,
    // which only "clear" removes — forgetting it on "dict" closed an open transcript for nothing.
    // "dict" wipes only dictation records, so only their writes go; "clear" wipes only
    // file/URL/text records, so dictation writes stay.
    if (kind === "dict") dropPendingWrites(isDictationRecord);
    else if (kind === "clear") dropPendingWrites(isFileStoreRecord);
    const done = (n: number, [one, many]: [string, string]) => {
      if (tabRef.current === "Recording & history") {
        setStoreMsg({ text: `Removed ${plural(n, one, many)}.` });
        setConfirming(null);
      }
      void loadHistory(true).catch(() => {});
    };
    const fail = (e: unknown) => {
      if (tabRef.current === "Recording & history") {
        setConfirming(null);
        setStoreMsg({ text: safeDisplayText(String(e), 200), error: true });
      } else console.error("store action failed:", e);
      // A wipe that failed on one folder may still have removed records from another.
      void loadHistory(true).catch(() => {});
    };
    setBusy("store", true); // set with the IPC, so nothing above can leave it stuck
    // [one, many]: delete_all_dictations returns one combined count of records and audio.
    const [op, what]: [Promise<number>, [string, string]] =
      kind === "dict"
        ? [deleteAllDictations(basePref), ["dictation or audio file", "dictations and audio files"]]
        : kind === "files"
          ? [removeTranscriptMedia("file", basePref), ["audio copy", "audio copies"]]
          : kind === "links"
            ? [removeTranscriptMedia("url", basePref), ["downloaded file", "downloaded files"]]
            : kind === "video"
              ? [removeTranscriptMedia("video", basePref), ["video file", "video files"]]
              : [
                  // forgetRecord's deleted path reads an earlier launch's lost requests from the
                  // history mirror, which only the Transcribe/History/Logs screens load: load it
                  // first (it never rejects), with the pre-wipe ids. Drop again after the await:
                  // an edit debounce firing meanwhile may have parked a write.
                  loadHistory().then(() => {
                    dropPendingWrites(isFileStoreRecord);
                    forgetRecord(null, { deleted: true });
                    return clearFileTranscriptions(basePref);
                  }),
                  ["transcript", "transcripts"],
                ];
    void op
      .then((n) => done(n, what))
      .catch(fail)
      .finally(() => {
        setBusy("store", false);
      });
  };
  // One dictation clock for text AND audio: display the stricter of the two
  // legacy values (the keys keep syncing separately for older builds), write
  // both on change. Rust enforces the same value on both sweeps
  // (AppSettings::effective_dictation_days) — keep the two in step.
  const dictDaysA = s.recording.recordingsRetentionDays ?? 0;
  const dictDaysB = s.transcribe?.dictationRetentionDays ?? 7;
  const dictDays =
    dictDaysA === 0 ? dictDaysB : dictDaysB === 0 ? dictDaysA : Math.min(dictDaysA, dictDaysB);
  const dictOff = s.transcribe?.keepDictationHistory === false && !s.recording.saveRecordings;
  // "Delete all dictations" also removes every dictation-* audio file, which outlives its
  // record when history is off but audio is kept — name both, or the confirm said "0".
  const dictN = storeStats?.dictationCount ?? 0;
  // Audio only: recordingsFiles also counts each .wav's .txt sidecar.
  const dictAudioN = storeStats?.recordingsAudioFiles ?? 0;
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

  // Only the Permissions tab reads `evdev` (runEvdevSetup refreshes it itself); re-probe on each
  // visit so a permission granted outside the app shows up.
  useEffect(() => {
    if (tab !== "Permissions") return;
    // A rejected probe offers "Set up", as the row did before the probe moved here (it must not
    // stay on "Checking…"); an earlier answer from this session is kept.
    void evdevStatus()
      .then(setEvdev)
      .catch(() => setEvdev((cur) => cur ?? { available: true, permitted: false, enabled: false }));
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
  // concurrent move over the same folders with the same stale `current`. A store wipe in flight
  // (`busy.store`) refuses a move too: it deletes from the very folder the move would walk.
  const changeRecDir = () =>
    void pickRecordingsDir()
      .then(async (picked) => {
        if (!picked) return;
        // The buttons are disabled during a move or a wipe, but the native picker may have opened
        // before it — say why the picked folder was not used instead of dropping it silently.
        if (busy.dir || busy.store) {
          if (tabRef.current === "Recording & history") {
            setStoreMsg({
              text: busy.dir
                ? "Another folder move is still running — pick the folder again when it finishes."
                : "A cleanup is still running — try the move again when it finishes.",
              error: true,
            });
          }
          return;
        }
        moveError = null;
        setStoreMsg(null);
        setBusy("dir", true);
        try {
          // A coalesced record write captured BEFORE the move would land after it and put
          // the pre-move paths straight back on disk — drop it, don't flush it.
          dropPendingWrites();
          try {
            // Read the live base, not the click-time closure: on Linux the picker isn't modal,
            // so a Reset or second Change… can finish a move while this picker is still open —
            // moving from the stale base would find nothing and strand the audio.
            const from = audioBasePref(useApp.getState().settings.recording);
            await moveAudioBase(from, picked);
          } catch (e) {
            // A partial move already rewrote the records that did move: reload either way.
            forgetRecord(null);
            void loadHistory(true).catch(() => {});
            throw e;
          }
          updateRecording({ audioBaseDir: picked });
          // Rust rewrote every record's mediaPath/sourcePath on disk; the load-once
          // mirror still holds the pre-move paths — and would write them back on edit.
          // The workbench registry holds them too (an overlay edit persists through it).
          forgetRecord(null);
          void loadHistory(true).catch(() => {});
        } finally {
          setBusy("dir", false);
        }
      })
      .catch(reportMoveError);
  const resetRecDir = () => {
    if (busy.dir || busy.store) return;
    moveError = null;
    setStoreMsg(null);
    setBusy("dir", true);
    dropPendingWrites();
    void moveAudioBase(basePref, null)
      .then(() => {
        updateRecording({ audioBaseDir: null, recordingsDir: null });
        forgetRecord(null);
        void loadHistory(true).catch(() => {});
      })
      .catch((e) => {
        // A partial move already rewrote the records that did move: reload either way.
        forgetRecord(null);
        void loadHistory(true).catch(() => {});
        reportMoveError(e);
      })
      .finally(() => setBusy("dir", false));
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
              desc="Insert each phrase as you talk, instead of the whole transcript when the session ends. Streaming backends only (batch inserts after transcribing). Push-to-talk inserts on release unless the insert method is Clipboard only, which types nothing and refreshes the clipboard per phrase. A profile can override this."
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
                  <Button size="sm" onClick={changeRecDir} disabled={dirBusy || storeBusy}>
                    {dirBusy ? "Moving…" : "Change…"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={resetRecDir}
                    disabled={dirBusy || storeBusy || !basePref}
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
                          {storeStats[t.bytesKey] > 0
                            ? `${fmtBytes(storeStats[t.bytesKey])} · ${fmtFull(storeStats[t.filesKey])}`
                            : "—"}
                        </span>
                      </span>
                    ))}
                    <span>
                      total{" "}
                      <span className="text-text">
                        {fmtBytes(AUDIO_STORE_TYPES.reduce((n, t) => n + storeStats[t.bytesKey], 0))}{" "}
                        · {fmtFull(AUDIO_STORE_TYPES.reduce((n, t) => n + storeStats[t.filesKey], 0))}
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
                onChange={(v) => {
                  // Off wipes the dictation records in Rust after the debounced save: issue every
                  // parked write now, ahead of that save, so it lands before the wipe — and a flip
                  // back on before the save reaches Rust keeps the edit. Anything parked later is
                  // dropped by listenRetentionSweeps / writeNow, gated on Rust's dictationsWiped.
                  if (!v) void flushRecordWrites();
                  updateTranscribe({ keepDictationHistory: v });
                }}
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
              desc={`Removes all ${plural(dictN, "stored dictation")}${dictAudioN > 0 ? ` and ${plural(dictAudioN, "audio file")}` : " and their audio"}. The retention clock stays as set.`}
              last
            >
              {confirming === "dict" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("dict")}>
                    {dictN > 0
                      ? `Delete ${plural(dictN, "dictation")}${dictAudioN > 0 ? ` + ${plural(dictAudioN, "audio file")}` : ""}`
                      : dictAudioN > 0
                        ? `Delete ${plural(dictAudioN, "audio file")}`
                        : "Delete"}
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
                options={withCurrentHeight(s.transcribe?.urlVideoMaxHeight)}
              />
            </SettingRow>
            <SettingRow
              title={SETTING.transcriptionRetention.label}
              desc="Files, links and text translations alike — transcript, corrections, speaker names and the audio copy leave together. Link audio removed this way can't be re-downloaded."
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
                    Delete {plural(storeStats?.fileMediaFiles ?? 0, "file")}
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
                    Delete {plural(storeStats?.linkMediaFiles ?? 0, "file")}
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
                    Delete {plural(storeStats?.videoMediaFiles ?? 0, "file")}
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
              desc={`Removes all ${plural(storeStats?.fileCount ?? 0, "file, link or text transcription", "file, link and text transcriptions")}, with their corrections, speaker names and stored audio.`}
              last
            >
              {confirming === "clear" ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="danger" onClick={() => runStoreAction("clear")}>
                    Delete {plural(storeStats?.fileCount ?? 0, "transcript")}
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
            <SettingRow
              title="Microphone access"
              desc="Required to capture your voice. Use Audio → Test microphone to check it works."
              last={!IS_LINUX}
            >
              {/* No IPC reads the OS permission, so claim nothing — point at the real test instead. */}
              <span className="text-[12.5px] text-faint">Managed by your system</span>
            </SettingRow>
            {IS_LINUX && (
              // The evdev backend can never exist off Linux (/dev/input) — hide, don't dead-switch.
              <>
                <SettingRow
                  title="Hardware hotkeys (evdev)"
                  desc="Reliable hold-to-talk + left/right modifiers + AltGr on Wayland by reading /dev/input. Reads all keyboard input — strictly opt-in, and needs the 'input' group."
                  last
                >
                  {evdev === null ? (
                    // Not probed yet: a live "Set up" here would offer the admin prompt to a user
                    // who is already set up.
                    <span className="text-[12px] text-faint">Checking…</span>
                  ) : !evdev.available ? (
                    <span className="text-[12.5px] text-faint">Unavailable</span>
                  ) : evdev.permitted ? (
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
