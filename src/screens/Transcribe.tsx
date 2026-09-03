import { ownProp } from "@/lib/own";
import { screenEyebrow, screenTitle } from "@/lib/screens";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import { UploadCloud, FileAudio, FileText, X, Loader2, Check, Plus, RotateCcw, ChevronsRight, Link2, AudioLines } from "lucide-react";
import { useApp } from "@/lib/store";
import {
  Button, Card, DisclosureCard, MicroLabel, Notice, PageHeader, Segmented, Select,
  SettingExpand, SettingRow, Stepper, TextInput, Toggle,
} from "@/components/ui";
import { DecodeFields } from "@/components/DecodeFields";
import { LanguageSelect } from "@/components/LanguageSelect";
import { ModelPicker } from "@/components/ModelPicker";
import { TranslationOptionsFields, pruneTargets, translationRunOptions } from "@/components/TranslationFields";
import { OverrideProfilePicker } from "@/components/OverrideProfilePicker";
import { TranscriptViewer, speakersOf } from "@/components/TranscriptViewer";
import { useOverrideContext } from "@/lib/useOverrideContext";
import { useBackendModels } from "@/lib/useBackendModels";
import { fmtBytes, fmtDurationExact, fmtTimestamp } from "@/lib/format";
import { pickAudioFiles, isTauri, urlPreview } from "@/lib/api";
import {
  activeRailIndex, addFiles, cancelRun, overallFraction, railStages, runBadgeFraction, stageTimeline,
  removeFile as removeFileAction, resetForInputChange, retryFile, selectPath,
  setUrlMeta, skippedStages, startRun, useTranscribeRun,
  type RailStage, type RunContext, type StepState, settledPanelItem, runTotals } from "@/lib/transcribeRun";
import {
  displayLabel, formatLabel, isSourceUrl, normalizeMediaUrl, urlHost, type UrlPreview,
} from "@/lib/urlSource";
import {
  loadHistory, useTranscriptHistory, type TranscriptRecord,
} from "@/lib/transcriptHistory";
import { closeRecord, openHistoryRecord } from "@/lib/transcribeRun";
import { backendOptions, backendPrompt, effectiveServerUrl } from "@/lib/backends";
import { effectiveServerKind } from "@/lib/serverKind";
import { isAcceptedSourcePath, isTextSourcePath } from "@/lib/subtitleImport";
import { acquireWarm, preloadPlanFor } from "@/lib/preload";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";
import {
  NO_OVERRIDE_PROFILE,
  type BatchProgress, type DecodeOverrides, type TranscribeOptions,
} from "@/lib/types";

/** Bound the "server ignored N overrides" list — untrusted response, real DOM. */
const MAX_IGNORED_SHOWN = 50;

/** Below this window width the Studio (side-by-side) arrangement is too narrow
 *  for the config rail and a readable transcript pane beside the 228px sidebar,
 *  so the page stays stacked. Picking Studio on a narrower window grows it. */
const STUDIO_MIN_WINDOW = 1400;
/** Studio's config rail: its default width, the narrowest it can be dragged, and the room
 *  the transcript pane always keeps beside it. */
const STUDIO_RAIL_DEFAULT = 520;
const STUDIO_RAIL_MIN = 360;
const STUDIO_PANE_MIN = 560;
/** Width consumed by the sidebar, page padding, flex gaps and splitter gutter that sits
 *  between window.innerWidth and the two content panes. */
const STUDIO_CHROME = 340;

/** Retro-translate runs whose transcript is NOT the one on screen: a slim
 *  strip in the Processing-card design language, so a run started on another
 *  record (same-URL siblings, or a record since closed) stays visible and
 *  reachable instead of silently running headless. */
function OtherTranslateRuns({ excludeKeys }: { excludeKeys: (string | null)[] }) {
  const trRuns = useApp((s) => s.trRuns);
  const records = useTranscriptHistory((s) => s.records);
  const running = useTranscribeRun((s) => s.running); // openHistoryRecord refuses mid-run
  const entries = Object.entries(trRuns).filter(([k]) => !excludeKeys.includes(k));
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5">
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-label text-faint">
        translating elsewhere
      </div>
      {entries.map(([key, { run }]) => {
        // Runs key by record id (or, before one exists, by source path).
        const rec = records.find((r) => r.id === key || r.sourcePath === key);
        return (
          <div key={key} className="flex items-center gap-3 py-1">
            <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--c-translate)]" />
            <span className="min-w-0 truncate font-mono text-[11.5px] text-text">
              {safeDisplayText(run.title ?? rec?.sourceName ?? key, 60)}
            </span>
            <span className="shrink-0 font-mono text-[11px] uppercase text-dim">
              {run.targets.join(", ")}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[color:var(--c-translate)]">
              {run.phase === "done" ? "done" : `${Math.round(run.pct * 100)}%`}
            </span>
            <span className="flex-1" />
            {rec && (
              <Button variant="ghost" size="sm" disabled={running} onClick={() => openHistoryRecord(rec)}>
                Open
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** "today 21:04 · 11m 10s · de · 4 speakers" — the recent-strip meta line. */
function recentMeta(rec: TranscriptRecord): string {
  const d = new Date(rec.createdAt);
  const parts: string[] = [];
  if (!Number.isNaN(d.getTime())) {
    const startOf = (x: Date) =>
      new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
    const day =
      diff <= 0 ? "today" : diff === 1 ? "yesterday" : d.toLocaleDateString();
    parts.push(`${day} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (rec.result?.duration) parts.push(fmtDurationExact(rec.result.duration));
  if (rec.language) parts.push(safeDisplayText(rec.language, 12));
  const spk = rec.result?.speakers?.length ?? 0;
  if (spk > 1) parts.push(`${spk} speakers`);
  const trLangs = rec.result?.translation?.targets?.length ?? 0;
  if (trLangs > 0) parts.push(`${trLangs} translation${trLangs === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Human label for a server progress stage (absent/unknown ⇒ generic). */
function stageLabel(p: BatchProgress | null): string {
  switch (p?.stage) {
    case "waiting":
      return "Waiting for a server slot…";
    case "resolving":
      return "Resolving link…";
    case "downloading":
      return "Downloading…";
    case "separating":
      return "Separating music…";
    case "analyzing":
      return "Analyzing audio…";
    case "transcribing":
      return "Transcribing…";
    case "diarizing":
      return "Identifying speakers…";
    case "translating":
      return "Translating…";
    default:
      return "Transcribing…";
  }
}

/** m:ss-style elapsed time for the rail's stage rows. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Display names + one-line explanations for the rail rows (the stage order
 *  itself lives in transcribeRun.railStages). */
const RAIL_NAMES: Record<RailStage, string> = {
  downloading: "Download",
  separating: "Music source separation",
  transcribing: "Transcribe",
  diarizing: "Speaker diarization",
  translating: "Translation",
};
const RAIL_DESCRIPTIONS: Record<RailStage, string> = {
  downloading: "Fetches the audio from the link on the server before the pipeline runs.",
  separating: "Vocals kept, music removed — the transcript decodes from the clean stem.",
  transcribing: "",
  diarizing: "Labels each segment with who is speaking.",
  translating: "Translates the finished segments into your target languages.",
};

/** Why a stage the run asked for did not happen — one sentence per stage. The
 *  old two-way branch predated `translating`/`downloading` on the rail and
 *  printed the diarization sentence for both. */
export const SKIPPED_EXPLANATIONS: Record<RailStage, string> = {
  downloading: " — the server already had the media.",
  separating: " — transcribing the original audio instead.",
  transcribing: "",
  diarizing: " — segments stay unlabeled.",
  translating: " — the transcript stays in its source language.",
};

/** Timeline-strip identity: a muted hue and a compact lowercase axis name
 *  per stage. Identity is carried by position + name — hue is redundant
 *  reinforcement, never the only channel. */
const STAGE_COLORS: Record<RailStage, string> = {
  downloading: "var(--c-download)",
  separating: "var(--c-separate)",
  transcribing: "var(--c-ok)",
  diarizing: "var(--c-diarize)",
  translating: "var(--c-translate)",
};
const AXIS_NAMES: Record<RailStage, string> = {
  downloading: "download",
  separating: "music source separation (MSS)",
  transcribing: "transcribe",
  diarizing: "speaker diarization",
  translating: "translate",
};

/** Measure an axis label's real pixel width in the app's mono face —
 *  estimating from a per-character constant undershot the variable-metrics
 *  fallback fonts and let labels overflow the card / collide with ticks. */
let axisMeasureCtx: CanvasRenderingContext2D | null | undefined;
function axisTextWidth(text: string): number {
  if (axisMeasureCtx === undefined) {
    axisMeasureCtx = document.createElement("canvas").getContext("2d");
    if (axisMeasureCtx) {
      const family =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "monospace";
      axisMeasureCtx.font = `10.5px ${family}`;
    }
  }
  if (!axisMeasureCtx) return text.length * 7;
  // tracking-[.03em] on the name line ≈ 0.32px per character.
  return axisMeasureCtx.measureText(text).width + text.length * 0.32;
}

/** Greedy left-to-right layout for the axis labels under the strip. A label
 *  keeps the top row when it fits inside its own segment and nothing before
 *  it overflows into its spot; otherwise it drops to the stagger row on a
 *  longer leader tick. A label that would run past the strip's right edge is
 *  pulled left to end exactly at it (`offset` ≤ 0, applied relative to its
 *  column). `px` are segment widths, `labelPx` measured label widths. */
export function axisLayout(
  px: number[],
  labelPx: number[],
  totalW: number,
): { row: 0 | 1; offset: number }[] {
  const out: { row: 0 | 1; offset: number }[] = [];
  let x = 0;
  let topEnd = -Infinity;
  let dropEnd = -Infinity;
  px.forEach((w, i) => {
    // Clamp so the label never crosses the strip's right edge.
    const xl = Math.min(x, Math.max(totalW - labelPx[i], 0));
    const clamped = xl < x - 0.5;
    const fitsOwn = (labelPx[i] <= w - 2 || i === px.length - 1) && !clamped;
    const maxStart = Math.max(totalW - labelPx[i], 0);
    let row: 0 | 1;
    let xUse = xl;
    if (fitsOwn && xl >= topEnd) {
      row = 0;
      topEnd = xl + labelPx[i] + 16;
    } else if (xl >= dropEnd) {
      row = 1;
      dropEnd = xl + labelPx[i] + 16;
    } else {
      // Neither row is clear at xl: take the row that frees up first and
      // start where it ends, so the label is pushed right instead of printed
      // through its predecessor (two tiny early stages at the 5px floor).
      const useTop = topEnd <= dropEnd;
      row = useTop ? 0 : 1;
      xUse = Math.min(Math.max(xl, useTop ? topEnd : dropEnd), maxStart);
      if (useTop) topEnd = xUse + labelPx[i] + 16;
      else dropEnd = xUse + labelPx[i] + 16;
    }
    out.push({ row, offset: xUse - x });
    x += w + 2;
  });
  return out;
}

/** Remaining-time estimate in ms: linear projection from the current rate,
 *  only once it is stable (≥5% done, ≥10 s elapsed) so it never appears as
 *  a wild early guess. */
function etaMs(frac: number | null, elapsedMs: number): number | null {
  if (frac === null || frac < 0.05 || frac >= 1 || elapsedMs < 10_000) return null;
  return (elapsedMs * (1 - frac)) / frac;
}

/** "about X left", rounded coarsely (5 s under ten minutes, whole minutes
 *  above) so consecutive polls never make the estimate jitter. */
function aboutLeft(ms: number): string {
  const s = Math.max(5, Math.round(ms / 1000 / 5) * 5);
  if (s < 600) {
    const m = Math.floor(s / 60);
    return m > 0
      ? `about ${m}m ${String(s % 60).padStart(2, "0")}s left`
      : `about ${s}s left`;
  }
  return `about ${Math.round(s / 60)}m left`;
}

export default function Transcribe() {
  const backends = useApp((s) => s.backends);
  const connections = useApp((s) => s.connections);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  // Recent transcripts for the idle-screen strip (full list: History screen).
  const historyRecords = useTranscriptHistory((s) => s.records);
  const recentRecords = useMemo(
    // Files only — dictations belong to the History screen's timeline.
    () => historyRecords.filter((r) => r.status === "done" && r.kind !== "dictation").slice(0, 3),
    [historyRecords],
  );
  useEffect(() => {
    void loadHistory();
  }, []);

  // Backend/model/language picks persist in settings.transcribe (they were
  // component state before, so leaving the screen reset them). The saved pick
  // only applies while that backend still exists; model/language ride on it.
  const savedBackend =
    settings.transcribe?.backendId &&
    backends.some((b) => b.id === settings.transcribe?.backendId)
      ? settings.transcribe.backendId
      : undefined;
  const [backendId, setBackendId] = useState(savedBackend ?? backends[0]?.id ?? "");
  const [language, setLanguage] = useState(
    (savedBackend ? settings.transcribe?.language : undefined) ??
      backends.find((b) => b.id === (savedBackend ?? backends[0]?.id))?.language ??
      "auto",
  );
  // "" = use the Backend's configured model; anything else is a per-run pick
  // from the models the server advertised on the last connection test.
  const [model, setModel] = useState(savedBackend ? (settings.transcribe?.model ?? "") : "");
  // Run state lives in the transcribeRun store so it (and the pump driving
  // it) survives this screen unmounting on a tab switch.
  const files = useTranscribeRun((s) => s.files);
  const queue = useTranscribeRun((s) => s.queue);
  const selectedPath = useTranscribeRun((s) => s.selectedPath);
  const progress = useTranscribeRun((s) => s.progress);
  const stageTimes = useTranscribeRun((s) => s.stageTimes);
  const stageMeta = useTranscribeRun((s) => s.stageMeta);
  const lastOptions = useTranscribeRun((s) => s.lastOptions);
  const lastOverrides = useTranscribeRun((s) => s.lastOverrides);
  const openRecordId = useTranscribeRun((s) => s.openRecordId);
  // "Silence skipping ate the file" notice — dismissed per file path.
  const [vadNoticeDismissed, setVadNoticeDismissed] = useState<string | null>(null);
  // Per-run stage options, seeded from the persisted screen defaults.
  const [diarize, setDiarize] = useState(() => settings.transcribe?.diarize ?? false);
  // Speaker count as an explicit MODE (auto / count / range) instead of a
  // stepper whose 0 doubles as "auto" — one accidental "−" click used to flip
  // the mode silently and persist. Legacy blobs have no speakerMode: a pinned
  // numSpeakers means "count" there.
  const [speakerMode, setSpeakerMode] = useState<"auto" | "count" | "range">(() => {
    const t = settings.transcribe;
    if (t?.speakerMode) return t.speakerMode;
    return (t?.numSpeakers ?? 0) > 0 ? "count" : "auto";
  });
  const [numSpeakers, setNumSpeakers] = useState(() =>
    Math.min(32, Math.max(1, settings.transcribe?.numSpeakers || 2)),
  );
  const [minSpeakers, setMinSpeakers] = useState(() =>
    Math.min(32, Math.max(1, settings.transcribe?.minSpeakers || 2)),
  );
  const [maxSpeakers, setMaxSpeakers] = useState(() =>
    Math.min(32, Math.max(1, settings.transcribe?.maxSpeakers || 4)),
  );
  const [translate, setTranslate] = useState(() => settings.transcribe?.translate ?? false);
  // T2T targets ([] = off) + sticky model and mode picks (all persisted via
  // persistOptions; the server default for mode is "fluent").
  const [translateTo, setTranslateTo] = useState<string[]>(
    () => settings.transcribe?.translateTo ?? [],
  );
  const [translationModel, setTranslationModel] = useState(
    () => settings.transcribe?.translationModel ?? "",
  );
  const [translationMode, setTranslationMode] = useState<"fluent" | "faithful">(
    () => settings.transcribe?.translationMode ?? "fluent",
  );
  // Per-run stage-model overrides ("" = server default) — runOverrides-style,
  // deliberately not persisted.
  const [diarizationModel, setDiarizationModel] = useState("");
  const [separationModel, setSeparationModel] = useState("");
  // One-line notice under whichever translate row was auto-switched off (the
  // two translation mechanisms are mutually exclusive). Cleared on interaction.
  const [translateExclNotice, setTranslateExclNotice] = useState<"whisper" | "t2t" | null>(null);
  const [separateBgm, setSeparateBgm] = useState(() => settings.transcribe?.separateBgm ?? false);
  // Per-RUN decode overrides layered over the Backend's stored defaults —
  // deliberately not persisted: this is "for this file, try beam 5", not a
  // settings edit (those live on the Backend / Profile editors).
  const [runOverrides, setRunOverrides] = useState<DecodeOverrides>({});
  // Per-run server override-profile pick; "" = inherit the Backend's. Same
  // not-persisted contract as runOverrides.
  const [runOverrideProfile, setRunOverrideProfile] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  // Transcribe-from-URL: the draft link, its debounced server preview, and a
  // sequence ref so a stale probe can never overwrite a newer draft's state.
  const [urlDraft, setUrlDraft] = useState("");
  const [urlPreviewData, setUrlPreviewData] = useState<UrlPreview | null>(null);
  const [urlPreviewErr, setUrlPreviewErr] = useState<string | null>(null);
  const [urlPreviewLoading, setUrlPreviewLoading] = useState(false);
  const urlPreviewSeq = useRef(0);
  // Prevents a double-click from opening two native file dialogs.
  const picking = useRef(false);
  // OS drag-and-drop is over the window (Tauri intercepts HTML5 drops).
  const [dragOver, setDragOver] = useState(false);
  // Window width drives the stacked/studio arrangement (Tauri desktop window;
  // there is no breakpoint system, and the sidebar is a fixed 228px).
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // OS drag-and-drop: Tauri's native interception owns the events (HTML5
  // drop never fires), so listen on the webview. Accepted files join the
  // queue exactly like picked ones; anything else is ignored quietly.
  useEffect(() => {
    if (!isTauri) return;
    let stale = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            setDragOver(true);
          } else if (event.payload.type === "drop") {
            setDragOver(false);
            const paths = event.payload.paths.filter(isAcceptedSourcePath);
            const running = useTranscribeRun
              .getState()
              .queue.some((it) => it.status === "running" || it.status === "queued");
            if (paths.length && !running) addFiles(paths);
          } else {
            setDragOver(false);
          }
        })
        .then((u) => {
          if (stale) u();
          else unlisten = u;
        })
        .catch((e) => console.warn("drag-drop registration failed:", e)),
    );
    return () => {
      stale = true;
      unlisten?.();
    };
  }, []);

  // The store boots with an EMPTY backend list (store.ts) and config hydration — also how a
  // sync pull or an import replaces it — fills it in. Re-sync the selection whenever the
  // current id isn't in the list (on the very first hydration `backendId` is still "", so this
  // branch also seeds the initial pick), so the Backend dropdown and language don't reference
  // a backend that's gone.
  // Every pick that names something on ONE server: the per-run whisper model,
  // a server override-profile, and the three stage-model ids. They must all
  // fall away together whenever the backend under the screen changes, or the
  // run ships ids the new server doesn't have (invisible when its picker
  // renders only for >1 advertised model).
  const clearBackendScopedPicks = () => {
    setModel("");
    setRunOverrideProfile("");
    setSeparationModel("");
    setDiarizationModel("");
    setTranslationModel("");
  };
  // ONE path for every backend change — the dropdown and the auto-resync above share it, so
  // they can't drift: the effect used to skip the run reset, the target prune and the language
  // persist, so a hydrated list left `settings.transcribe.language` on the OLD backend's
  // language (which snapped back on the next mount).
  const applyBackendPick = (id: string) => {
    resetForInputChange();
    setBackendId(id);
    clearBackendScopedPicks(); // model, profile and stage models all name ONE server
    const b = backends.find((x) => x.id === id);
    const lang = b?.language ?? "auto";
    setLanguage(lang);
    const nextT = pruneTargets(translateTo, lang);
    if (nextT.length !== translateTo.length) setTranslateTo(nextT);
    persistOptions({ backendId: id, model: "", translationModel: "", language: lang, translateTo: nextT });
  };
  useEffect(() => {
    if (backends.length && !backends.some((b) => b.id === backendId)) {
      // Guard: don't abandon an in-flight run when a sync push replaces the backends list.
      // The user gestures behind `applyBackendPick` are already `disabled={busy}`, but this
      // effect fires on store changes (applyBlob, conflict resolution) with no such gate.
      const isRunning = queue.some((it) => it.status === "running" || it.status === "queued");
      if (isRunning) return;
      applyBackendPick(backends[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the resets are stable setters
  }, [backends, backendId, queue]);

  const backend = backends.find((b) => b.id === backendId) ?? backends[0];
  const serverKind = backend ? effectiveServerKind(backend, ownProp(connections, backend.id)) : "unknown";
  // "unknown" must never gate (serverKind.ts contract) — only a PROVEN
  // standard server hides the full-backend-only stages.
  const isStandard = serverKind === "standard";

  // Capability gate + inherited baseline for the per-run decode editor —
  // the same context the Backend/Profile editors use.
  const { caps, resolved } = useOverrideContext({
    serverUrl: backend ? effectiveServerUrl(backend, settings) : "",
    backendId: backend?.id,
    // The EFFECTIVE profile — the per-run pick wins, exactly as the run sends it — so the
    // ghosted "Empty = inherit" baseline and the Skip-silence "Default · on/off" describe
    // what this run will actually inherit, not the backend's profile.
    profileName: (runOverrideProfile || backend?.overrideProfile) || undefined,
    serverKind,
  });
  // What a blank per-run field inherits: profile baseline, overridden by the
  // Backend's stored decode defaults (the Profiles editor's merge precedent).
  const inheritedBaseline = { ...resolved, ...backend?.decodeOverrides };

  // Per-run model pick: "" = backend default. The advertised list comes from
  // the shared hook (session connection cache + one background probe).
  const advertised = useBackendModels(backend);

  // The Skip-silence row's "Default" label: what a blank vad_filter inherits —
  // the Backend/profile baseline first, else the server-reported default.
  // undefined = unknown (older server) → plain "Default".
  const vadBaseline = inheritedBaseline.vad_filter;
  const vadInherited =
    typeof vadBaseline === "boolean" ? vadBaseline : caps?.vad_filter_default;

  // Pre-flight availability of the optional pipeline stages (additive
  // capability fields). Only an explicit false disables the toggle — absent
  // means an older backend, and we never gate a knob we can't prove is
  // unsupported (the run would then just soft-fail into a "skipped" rail row).
  const bgmAvailable = caps?.bgm_separation_enabled !== false;
  const diarAvailable = caps?.diarization_enabled !== false;
  // Transcribe-from-URL is opt-in, unlike the two stage gates above: absent
  // means the endpoint does not exist (older backend / standard server), so
  // only an explicit true shows the link affordance.
  const urlAvailable = !isStandard && caps?.url_download_enabled === true;
  // T2T translation is opt-in like URL download: absent = the stage does not
  // exist on this server (older backend / standard server).
  const translationAvailable = !isStandard && caps?.translation_enabled === true;
  const urlMeta = useTranscribeRun((s) => s.urlMeta);

  const busy = queue.some((it) => it.status === "running" || it.status === "queued");
  const runningOverall = useTranscribeRun(runBadgeFraction);
  const lastRunPath = useTranscribeRun((st) => st.lastRunPath);

  // Warm the models the pending run will need, while the user is still choosing
  // options. ONE effect rather than a call at each entry point: addFiles lives in
  // the store module and has no backend, caps or option state in scope, so this
  // is the only place that can build the plan — and it covers drag-drop, the URL
  // row and the file picker alike, since all three end in `files`.
  // Held only while there is something queued and nothing running: once the run
  // starts, the run itself keeps the models hot.
  useEffect(() => {
    if (!backend || !files.length || busy) return;
    const forUrl = files.some((p) => isSourceUrl(p));
    const forText = files.every((p) => !isSourceUrl(p) && isTextSourcePath(p));
    // The same gating `run()` applies, so we never ask the server to warm a
    // stage this run would not actually request.
    const t2t = translationAvailable && translateTo.length > 0;
    const stages = railStages(
      {
        ...(t2t ? { translateTo } : {}),
        ...(diarize && diarAvailable && !isStandard ? { diarize: true } : {}),
        ...(separateBgm && bgmAvailable && !isStandard ? { separateBgm: true } : {}),
      },
      forUrl,
      forText,
    );
    const plan = preloadPlanFor({
      stages,
      whisperModel: model || backend.model,
      separationModel,
      diarizationModel,
      translationModel: translationModel || backend.translationOverrides?.model,
    });
    if (!plan.length) return;
    const lease = acquireWarm("transcribe", {
      serverUrl: effectiveServerUrl(backend, settings),
      backendId: backend.id,
      models: plan,
    });
    return () => lease.release();
  }, [
    files,
    busy,
    backend,
    settings,
    isStandard,
    translationAvailable,
    translateTo,
    translationModel,
    diarize,
    diarAvailable,
    diarizationModel,
    separateBgm,
    bgmAvailable,
    separationModel,
    model,
  ]);

  // Debounced (500 ms) link preview. Advisory only: a failed probe shows its
  // reason but never blocks Add — the run itself is the authority.
  useEffect(() => {
    const url = normalizeMediaUrl(urlDraft);
    setUrlPreviewData(null);
    setUrlPreviewErr(null);
    const seq = ++urlPreviewSeq.current;
    if (!url || !urlAvailable || !backend) {
      setUrlPreviewLoading(false);
      return;
    }
    setUrlPreviewLoading(true);
    const timer = window.setTimeout(() => {
      urlPreview({
        serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
        backendId: backend.id,
        url,
      })
        .then((p) => {
          if (urlPreviewSeq.current !== seq) return;
          setUrlPreviewData(p);
          setUrlPreviewLoading(false);
        })
        .catch((e) => {
          if (urlPreviewSeq.current !== seq) return;
          setUrlPreviewErr(safeDisplayText(String(e), 300) || "Link preview failed.");
          setUrlPreviewLoading(false);
        });
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlDraft, urlAvailable, backend?.id]);

  const addLink = () => {
    const url = normalizeMediaUrl(urlDraft);
    if (!url || busy) return;
    if (urlPreviewData) {
      setUrlMeta(url, {
        title: urlPreviewData.title ?? undefined,
        durationSec: urlPreviewData.duration ?? undefined,
        uploader: urlPreviewData.uploader ?? undefined,
        extractor: urlPreviewData.extractor ?? undefined,
        estimatedBytes: urlPreviewData.estimated_bytes ?? undefined,
        format: formatLabel(urlPreviewData.ext, urlPreviewData.abr) ?? undefined,
      });
    }
    addFiles([url]);
    setUrlDraft("");
    setUrlPreviewData(null);
    setUrlPreviewErr(null);
  };

  // 1 s heartbeat while a run is active, so the rail's elapsed times count
  // even when no server poll lands (standard servers, waiting stages).
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // Pixel width of the timeline strip — the axis-label row assignment (top
  // row vs stagger row) needs real segment widths. Measured after every
  // commit (cheap; setState only on change) plus on window resize.
  const stripRoRef = useRef<ResizeObserver | null>(null);
  const [stripW, setStripW] = useState(640);
  useEffect(() => () => { stripRoRef.current?.disconnect(); }, []);
  const stripBoxRef = useCallback((el: HTMLDivElement | null) => {
    stripRoRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setStripW(w);
    });
    ro.observe(el);
    stripRoRef.current = ro;
  }, []);

  const doneCount = queue.filter((it) => it.status === "done").length;
  const selected = queue.find((it) => it.path === selectedPath && it.status === "done");
  const result = selected?.result ?? null;

  // Studio (config rail left, transcript right) needs a wide window. The
  // persisted pick wins; auto = studio once a transcript exists.
  const wideEnough = winW >= STUDIO_MIN_WINDOW;
  const layoutPref = settings.transcribe?.layout;
  const studio =
    wideEnough && (layoutPref === "studio" || (layoutPref !== "stacked" && !!result));

  const persistOptions = (patch: Partial<NonNullable<typeof settings.transcribe>>) => {
    updateSettings({ transcribe: { ...settings.transcribe, ...patch } });
  };

  // The studio splitter: the rail width lives in the transcribe settings (local, never
  // synced); while a drag is in flight the live value is local state, persisted on release.
  const [railDrag, setRailDrag] = useState<number | null>(null);
  const railMax = Math.max(STUDIO_RAIL_MIN, winW - STUDIO_CHROME - STUDIO_PANE_MIN);
  const clampRail = (px: number) => Math.round(Math.min(railMax, Math.max(STUDIO_RAIL_MIN, px)));
  const railPx = clampRail(railDrag ?? settings.transcribe?.studioRailPx ?? STUDIO_RAIL_DEFAULT);
  const onRailPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const start = railPx;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setRailDrag(clampRail(start + ev.clientX - startX));
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const final = clampRail(start + ev.clientX - startX);
      setRailDrag(null);
      const { settings: cur } = useApp.getState();
      updateSettings({ transcribe: { ...cur.transcribe, studioRailPx: final } });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onRailKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -24 : e.key === "ArrowRight" ? 24 : e.key === "Home" ? -railPx : e.key === "End" ? railMax : null;
    if (step === null) return;
    e.preventDefault();
    persistOptions({ studioRailPx: clampRail(railPx + step) });
  };

  const choose = async () => {
    if (picking.current || busy) return;
    picking.current = true;
    let paths: string[];
    try {
      paths = await pickAudioFiles();
    } catch (e) {
      console.error("pick audio files failed:", e);
      return;
    } finally {
      picking.current = false;
    }
    if (paths.length) {
      addFiles(paths); // changed inputs abandon any settled results
    }
  };

  const removeFile = (path: string) => {
    if (busy) return;
    removeFileAction(path);
  };

  /** Everything the detached pump needs, frozen at run/retry time. */
  const buildCtx = (overrides: DecodeOverrides): RunContext | null => {
    if (!backend) return null;
    // Per-run overrides win over the Backend's stored defaults.
    const merged = { ...backend.decodeOverrides, ...overrides };
    return {
      backendId: backend.id,
      serverUrl: effectiveServerUrl(backend, useApp.getState().settings),
      model: model || backend.model,
      language,
      // Tri-state: unset = inherit the server DEFAULT_PROMPT (omit the field), an
      // explicit clear = send "" (suppress it), a value = send it. `|| undefined`
      // collapsed clear onto inherit.
      prompt: backendPrompt(backend),
      decodeOverrides: Object.keys(merged).length ? merged : undefined,
      // Per-run pick wins ("" = inherit); NO_OVERRIDE_PROFILE passes through
      // verbatim (it forces "no profile" server-side).
      overrideProfile: runOverrideProfile || backend.overrideProfile,
      standard:
        effectiveServerKind(backend, ownProp(useApp.getState().connections, backend.id)) === "standard",
    };
  };

  const run = () => {
    if (!files.length || !backend || busy) return;
    setVadNoticeDismissed(null); // fresh results argue their own case
    // The screen's toggle/chips are AUTHORITATIVE (an empty list = off) —
    // Backend defaults only seed the toggle, they never force the stage on
    // (an invisible fallback made translation impossible to switch off and
    // silently swallowed an explicit Translate-to-English).
    const effTargets = translationAvailable ? translateTo : [];
    const t2t = effTargets.length > 0;
    // "Authoritative" now has to be SAID, not just implied by omission: the server reads
    // an absent `translate_to` as "inherit my override-profile's TRANSLATE_TO", so an
    // empty chip list goes out as an explicit empty — see `translationRunOptions`, which
    // also carries the backend glossary's own tri-state through.
    const t2tOptions = translationRunOptions({
      available: translationAvailable,
      targets: effTargets,
      mode: translationMode,
      model: translationModel || backend.translationOverrides?.model,
      glossary: backend.translationOverrides?.glossary,
    });
    // Always present for a standard server (it carries the wire-shaping `standard` flag
    // even when no stage is on), else only when a stage asked for something.
    const options: TranscribeOptions | undefined =
      isStandard || diarize || translate || separateBgm || t2tOptions.translateTo !== undefined
        ? {
            ...(isStandard ? { standard: true } : {}),
            // Belt-and-braces exclusivity: when a sync race left both set,
            // T2T wins and Whisper's task is omitted entirely.
            ...(translate && !t2t
              ? { task: "translate" as const, useTranslationsEndpoint: isStandard }
              : {}),
            ...t2tOptions,
            ...(diarize && diarAvailable && !isStandard
              ? {
                  diarize: true,
                  ...(speakerMode === "count" ? { numSpeakers } : {}),
                  ...(speakerMode === "range" ? { minSpeakers, maxSpeakers } : {}),
                  ...(diarizationModel ? { diarizationModel } : {}),
                }
              : {}),
            ...(separateBgm && bgmAvailable && !isStandard
              ? { separateBgm: true, ...(separationModel ? { separationModel } : {}) }
              : {}),
          }
        : undefined;
    const ctx = buildCtx(runOverrides);
    if (ctx) startRun(options, runOverrides, ctx);
  };

  const retry = (path: string) => {
    if (busy) return;
    const ctx = buildCtx(useTranscribeRun.getState().lastOverrides);
    if (ctx) retryFile(path, ctx);
  };

  /** The VAD notice's one-click fix: force vad_filter off (visible in the
   *  Skip-silence row + decode editor, since it's the same key) and re-run
   *  the file with the otherwise-unchanged run settings. */
  const retryWithoutVad = (path: string) => {
    if (busy) return;
    const next: DecodeOverrides = { ...runOverrides, vad_filter: false };
    setRunOverrides(next);
    const ctx = buildCtx(next);
    if (ctx) retryFile(path, ctx, next);
  };

  // Opening a transcript (a history pick, or a run that just finished) lands
  // the viewer below the Recent strip in the stacked column — bring it into
  // view so the user isn't left staring at the unchanged elements above it.
  // Studio needs nothing: the right pane always shows the viewer. Eased by
  // hand — WebKitGTK ignores scrollTo({behavior:"smooth"}).
  useEffect(() => {
    if (!result || studio) return;
    const el = document.querySelector("[data-transcript-viewer]");
    if (!(el instanceof HTMLElement)) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    if (!scroller) return;
    const from = scroller.scrollTop;
    const target = Math.max(
      0,
      Math.min(
        from + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16,
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
    const dist = target - from;
    if (Math.abs(dist) < 1) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scroller.scrollTop = target;
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 450);
      scroller!.scrollTop = from + dist * (1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Trigger on the OPENED TRANSCRIPT changing, never on a layout switch or
    // a re-render — `result` is a stable object per record/run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // ── render ───────────────────────────────────────────────────────────────
  // The page assembles from four blocks so the stacked column and the studio
  // two-pane arrangement can share every section unchanged.
  const header = (
    <div>
      <PageHeader eyebrow={screenEyebrow("transcribe")} title={screenTitle("transcribe")} icon={AudioLines}>
        Add audio or video files, links to audio or video content, or text files, then transcribe, translate and diarize them.
        <br />A <strong className="font-semibold text-text">faster-whisper-backend</strong> server is needed.
      </PageHeader>
      <div className="page-content flex justify-start">
      <Segmented
        value={studio ? "studio" : "stacked"}
        ariaLabel="Page layout"
        onChange={(v) => {
          persistOptions({ layout: v });
          // Studio needs room: on a narrower window, grow it to the minimum
          // width — the resize event then flips the layout over.
          if (v === "studio" && !wideEnough && isTauri) {
            void (async () => {
              try {
                // Dynamic import like every other Tauri API call site — a
                // static import here pulls window.js (and its event.js) into
                // the main chunk and defeats their lazy loading elsewhere.
                const { getCurrentWindow, LogicalSize } = await import(
                  "@tauri-apps/api/window"
                );
                const win = getCurrentWindow();
                const size = (await win.innerSize()).toLogical(await win.scaleFactor());
                if (size.width < STUDIO_MIN_WINDOW) {
                  await win.setSize(new LogicalSize(STUDIO_MIN_WINDOW, size.height));
                }
              } catch (e) {
                console.error("window resize for studio layout failed:", e);
              }
            })();
          }
        }}
        options={[
          { value: "stacked", label: "Stacked" },
          { value: "studio", label: "Studio" },
        ]}
      />
      </div>
    </div>
  );

  const configSections = (
    <>
      {files.length ? (
        <div
          className={cn(
            "mt-5 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-8",
            // Drops still add files in this state — say so, like the empty dropzone does.
            dragOver && !busy && "border-accent bg-accent-soft/30",
          )}
        >
          <div className="flex max-w-full flex-wrap items-center justify-center gap-3">
            {files.map((path) => (
              <div
                key={path}
                className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3"
              >
                {isSourceUrl(path) ? (
                  <Link2 className="size-5 shrink-0 text-accent" />
                ) : isTextSourcePath(path) ? (
                  <FileText className="size-5 shrink-0 text-accent" />
                ) : (
                  <FileAudio className="size-5 shrink-0 text-accent" />
                )}
                <span className="max-w-[300px] truncate text-[13px] text-text">
                  {displayLabel(path, urlMeta[path]?.title)}
                  {isSourceUrl(path) && (
                    <span className="ml-2 font-mono text-[11px] text-faint">{urlHost(path)}</span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${displayLabel(path, urlMeta[path]?.title)}`}
                  disabled={busy}
                  onClick={() => removeFile(path)}
                  className="ring-signal grid size-6 place-items-center rounded-lg text-faint transition-colors hover:text-rec disabled:opacity-40"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={choose}
            disabled={busy}
            className="ring-signal mt-4 inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text disabled:opacity-40"
          >
            <Plus className="size-3.5" /> Add more files
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={choose}
          className={cn(
            "ring-signal mt-5 grid w-full place-items-center rounded-card border border-dashed border-line-strong bg-surface/60 px-8 py-12 text-center transition-colors hover:border-faint",
            dragOver && "border-accent bg-accent-soft/30",
          )}
        >
          <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-faint">
            <UploadCloud className="size-6" />
          </div>
          <div className="mt-4 text-[14px] text-text">
            {dragOver ? "Drop to add" : "Choose or drop files to transcribe"}
          </div>
          <div className="mt-1 text-[12.5px] text-dim">Audio, video — or subtitles/text to translate (srt, vtt, lrc, txt, json)</div>
        </button>
      )}

      {urlAvailable && (
        <div className="mt-4">
          {/* One queue, two ways in: the link row sits under the dropzone
              behind a quiet divider — files and links mix in one run. */}
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-label text-faint">
            <span aria-hidden className="h-px flex-1 bg-line" />
            or paste a link
            <span aria-hidden className="h-px flex-1 bg-line" />
          </div>
          <div className="mt-3 flex gap-2.5">
            <TextInput
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && normalizeMediaUrl(urlDraft) && !busy) addLink();
              }}
              disabled={busy}
              spellCheck={false}
              placeholder="YouTube, podcast episode, or a direct audio/video link — https://…"
              aria-label="Media link"
              className="font-mono text-[12.5px]"
            />
            <Button
              variant="accent"
              className="shrink-0 whitespace-nowrap"
              disabled={!normalizeMediaUrl(urlDraft) || busy}
              onClick={addLink}
            >
              <Plus className="size-4" /> Add link
            </Button>
          </div>
          {urlDraft.trim() !== "" && !normalizeMediaUrl(urlDraft) && (
            <div className="mt-2 text-[12px] text-warn">
              Include http:// or https:// at the start of the link.
            </div>
          )}
          {urlPreviewLoading && (
            <div className="mt-3 flex items-center gap-2 text-[12.5px] text-dim">
              <Loader2 className="size-3.5 animate-spin" /> Resolving link…
            </div>
          )}
          {urlPreviewErr && (
            <Notice className="mt-3">
              <div>{urlPreviewErr}</div>
              <div className="mt-0.5 text-[12px] text-dim">
                You can still add the link — the run itself decides.
              </div>
            </Notice>
          )}
          {urlPreviewData && (
            <div className="mt-3 flex items-center gap-4 rounded-card border border-line bg-surface px-4 py-3.5">
              {urlPreviewData.thumbnail?.startsWith("data:image/") && (
                <img
                  src={urlPreviewData.thumbnail}
                  alt=""
                  className="w-[120px] shrink-0 rounded-lg object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13.5px] font-medium text-text">
                  {safeDisplayText(urlPreviewData.title, 120) ||
                    displayLabel(normalizeMediaUrl(urlDraft) ?? urlDraft)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-dim">
                  {urlPreviewData.uploader && (
                    <span>{safeDisplayText(urlPreviewData.uploader, 60)}</span>
                  )}
                  {typeof urlPreviewData.duration === "number" && urlPreviewData.duration > 0 && (
                    <span className="font-mono tabular-nums">
                      {fmtDurationExact(urlPreviewData.duration)}
                    </span>
                  )}
                  {typeof urlPreviewData.estimated_bytes === "number" &&
                    urlPreviewData.estimated_bytes > 0 && (
                      <span className="font-mono tabular-nums">
                        ≈ {fmtBytes(urlPreviewData.estimated_bytes)}
                      </span>
                    )}
                  {formatLabel(urlPreviewData.ext, urlPreviewData.abr) && (
                    <span className="font-mono tabular-nums">
                      {safeDisplayText(formatLabel(urlPreviewData.ext, urlPreviewData.abr)!, 32)}
                    </span>
                  )}
                  {urlPreviewData.extractor && (
                    <span className="rounded-pill bg-accent-soft px-2 py-px font-mono text-[10.5px] uppercase tracking-label text-accent">
                      {safeDisplayText(urlPreviewData.extractor, 24)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 grid grid-cols-3 gap-4">
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Backend</label>
          <Select
            ariaLabel="Backend"
            value={backendId}
            // A backend change is an input change: abandon any in-flight run + clear stale
            // results, else the prior backend's transcript/error shows under the new selection.
            onChange={applyBackendPick}
            disabled={busy}
            options={backendOptions(backends)}
          />
        </div>
        <div>
          {/* Reset lives in the LABEL row (decode-editor treatment: accent dot
              = overridden, ↺ right-aligned) — under the field it added height
              to this cell only and broke the three-column baseline. */}
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-dim">
            <label>Model</label>
            {model !== "" && (
              <>
                <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    resetForInputChange();
                    setModel("");
                    persistOptions({ backendId, model: "" });
                  }}
                  title={backend?.model ? `Default · ${backend.model}` : "Default · server model"}
                  className="ring-signal ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 text-[11px] font-normal text-faint hover:text-text"
                >
                  <RotateCcw className="size-3" /> use default
                </button>
              </>
            )}
          </div>
          <ModelPicker
            ariaLabel="Model"
            value={model}
            disabled={busy}
            onChange={(v) => {
              resetForInputChange();
              setModel(v);
              persistOptions({ backendId, model: v });
            }}
            models={advertised}
            defaultLabel={backend?.model ? `Default · ${backend.model}` : "Default · server model"}
            hideReset
          />
        </div>
        <div>
          <label className="mb-2 block text-[12px] font-medium text-dim">Language</label>
          <LanguageSelect
            ariaLabel="Language"
            value={language}
            disabled={busy}
            onChange={(v) => {
              resetForInputChange();
              setLanguage(v);
              // The seed never targets the known source; keep that true when the
              // source changes AFTER seeding (a de→de stage is a no-op run).
              const next = pruneTargets(translateTo, v);
              if (next.length !== translateTo.length) setTranslateTo(next);
              persistOptions({ backendId, language: v, translateTo: next });
            }}
          />
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2.5 font-mono text-[11px] uppercase tracking-label text-faint">processing</div>
        {/* Rows in PIPELINE order — the card previews the run rail: separate
            music → skip silence (analysis) → transcribe (translate is the
            decode's task) → identify speakers. The hairline + dots say
            "sequence" without over-claiming stages (skip-silence and translate
            live inside the transcribe stage). */}
        <Card className="px-5 py-1">
          {isStandard ? (
            <SettingRow
              title="Translate to English"
              desc="The decode itself outputs English instead of the source language (Whisper's translate task)."
              last
            >
              <Toggle
                checked={translate}
                ariaLabel="Translate to English"
                onChange={(v) => {
                  setTranslate(v);
                  persistOptions({ translate: v });
                }}
              />
            </SettingRow>
          ) : (
            <div className="relative pl-6">
              <span
                aria-hidden
                className="absolute bottom-[26px] left-[6px] top-[26px] w-px bg-line-strong"
              />
              <div className="relative">
                <span aria-hidden className="absolute -left-[21px] top-[22px] size-[7px] rounded-full bg-faint" />
                {/* Header = the toggle alone; the model pick lives in the
                    expand sub-panel so the header column stays aligned with
                    every other row (the old inline picker crushed it). */}
                <SettingRow
                  title="Music source separation (MSS)"
                  desc={
                    bgmAvailable
                      ? "Runs first — strips music so everything after sees clean vocals (UVR). Adds processing time per file."
                      : "Not available on this server (BGM_SEPARATION_ENABLED is off)."
                  }
                  disabled={!bgmAvailable}
                  expand={
                    separateBgm && bgmAvailable && (caps?.separation_models?.length ?? 0) > 1 ? (
                      <SettingExpand>
                        <div>
                          <MicroLabel>model</MicroLabel>
                          <div className="w-56">
                            <ModelPicker
                              value={separationModel}
                              onChange={setSeparationModel}
                              models={caps?.separation_models ?? []}
                              defaultLabel={`Default · ${caps?.separation_models?.[0]?.id ?? "server model"}`}
                              ariaLabel="Separation model"
                            />
                          </div>
                        </div>
                      </SettingExpand>
                    ) : undefined
                  }
                >
                  <Toggle
                    checked={separateBgm && bgmAvailable}
                    disabled={!bgmAvailable}
                    ariaLabel="Music source separation"
                    onChange={(v) => {
                      setSeparateBgm(v);
                      persistOptions({ separateBgm: v });
                    }}
                  />
                </SettingRow>
              </div>
              <div className="relative">
                <span aria-hidden className="absolute -left-[21px] top-[22px] size-[7px] rounded-full bg-faint" />
                {/* Promoted view of runOverrides.vad_filter — the SAME key the
                    Decode-overrides editor edits (one source of truth, two
                    doors: changing it here makes the disclosure count "1 set
                    for this run", and reset works from either place).
                    Tri-state, not a Toggle: the server has its own default,
                    and an unset boolean must stay distinct from an explicit
                    false. */}
                <SettingRow
                  title="Skip silence (VAD)"
                  desc="Voice activity detection during audio analysis — silence never reaches the decoder: faster, and prevents made-up text in quiet parts. For this run only."
                >
                  <Segmented
                    value={
                      runOverrides.vad_filter === true
                        ? "on"
                        : runOverrides.vad_filter === false
                          ? "off"
                          : "inherit"
                    }
                    ariaLabel="Skip silence (VAD)"
                    disabled={caps?.can_request_decode_overrides === false}
                    onChange={(v) => {
                      const next = { ...runOverrides };
                      if (v === "inherit") delete next.vad_filter;
                      else next.vad_filter = v === "on";
                      setRunOverrides(next);
                    }}
                    options={[
                      {
                        value: "inherit",
                        label:
                          vadInherited === undefined
                            ? "Default"
                            : `Default · ${vadInherited ? "on" : "off"}`,
                      },
                      { value: "on", label: "On" },
                      { value: "off", label: "Off" },
                    ]}
                  />
                </SettingRow>
              </div>
              <div className="relative">
                <span aria-hidden className="absolute -left-[21px] top-[22px] size-[7px] rounded-full bg-faint" />
                <SettingRow
                  title="Translate to English"
                  desc={
                    translationAvailable
                      ? "During decode — the transcript comes out in English only; the original text is not kept (Whisper's translate task)."
                      : "The decode itself outputs English instead of the source language (Whisper's translate task)."
                  }
                >
                  <Toggle
                    checked={translate}
                    ariaLabel="Translate to English"
                    onChange={(v) => {
                      setTranslate(v);
                      // Mutually exclusive with the T2T stage: switching this
                      // on switches Translation off (and says so).
                      if (v && translateTo.length) {
                        setTranslateTo([]);
                        setTranslateExclNotice("t2t");
                        persistOptions({ translate: v, translateTo: [] });
                      } else {
                        setTranslateExclNotice(null);
                        persistOptions({ translate: v });
                      }
                    }}
                  />
                </SettingRow>
                {translateExclNotice === "whisper" && (
                  <p className="-mt-2 pb-3 text-[12px] text-warn">
                    Turned off — Translation (below) replaces it; the two can't combine.
                  </p>
                )}
              </div>
              <div className="relative">
                <span aria-hidden className="absolute -left-[21px] top-[22px] size-[7px] rounded-full bg-faint" />
                {/* Toggle-only header (the old header carried a model picker,
                    two steppers AND a segmented control — the crush bug); the
                    speaker mode + model live in the expand sub-panel. */}
                <SettingRow
                  title="Speaker diarization"
                  desc={
                    diarAvailable
                      ? "Runs last — labels each segment with who is speaking."
                      : "Not available on this server (DIARIZATION_ENABLED is off)."
                  }
                  disabled={!diarAvailable}
                  last={!translationAvailable}
                  expand={
                    diarize && diarAvailable ? (
                      <SettingExpand>
                        <div>
                          <MicroLabel>speakers</MicroLabel>
                          <div className="flex flex-wrap items-center gap-2">
                            <Segmented
                              value={speakerMode}
                              onChange={(m) => {
                                setSpeakerMode(m);
                                // numSpeakers keeps its pre-mode meaning on disk
                                // (0 = auto) so old sync peers read it right.
                                persistOptions({
                                  speakerMode: m,
                                  numSpeakers: m === "count" ? numSpeakers : 0,
                                });
                              }}
                              options={[
                                { value: "auto", label: "Auto" },
                                { value: "count", label: "Count" },
                                { value: "range", label: "Range" },
                              ]}
                              ariaLabel="Speaker count mode"
                            />
                            {speakerMode === "count" && (
                              <Stepper
                                value={numSpeakers}
                                onChange={(v) => {
                                  setNumSpeakers(v);
                                  persistOptions({ numSpeakers: v });
                                }}
                                min={1}
                                max={32}
                                ariaLabel="Speaker count"
                              />
                            )}
                            {speakerMode === "range" && (
                              <>
                                <Stepper
                                  value={minSpeakers}
                                  onChange={(v) => {
                                    const mx = Math.max(v, maxSpeakers);
                                    setMinSpeakers(v);
                                    setMaxSpeakers(mx);
                                    persistOptions({ minSpeakers: v, maxSpeakers: mx });
                                  }}
                                  min={1}
                                  max={32}
                                  ariaLabel="Minimum speakers"
                                />
                                <span className="text-[12px] text-dim">to</span>
                                <Stepper
                                  value={maxSpeakers}
                                  onChange={(v) => {
                                    const mn = Math.min(v, minSpeakers);
                                    setMaxSpeakers(v);
                                    setMinSpeakers(mn);
                                    persistOptions({ maxSpeakers: v, minSpeakers: mn });
                                  }}
                                  min={1}
                                  max={32}
                                  ariaLabel="Maximum speakers"
                                />
                              </>
                            )}
                          </div>
                        </div>
                        {(caps?.diarization_models?.length ?? 0) > 1 && (
                          <div>
                            <MicroLabel>model</MicroLabel>
                            <div className="w-56">
                              <ModelPicker
                                value={diarizationModel}
                                onChange={setDiarizationModel}
                                models={caps?.diarization_models ?? []}
                                defaultLabel={`Default · ${caps?.diarization_models?.[0]?.id?.split("/").pop() ?? "server model"}`}
                                ariaLabel="Diarization model"
                              />
                            </div>
                          </div>
                        )}
                      </SettingExpand>
                    ) : undefined
                  }
                >
                  <Toggle
                    checked={diarize && diarAvailable}
                    disabled={!diarAvailable}
                    ariaLabel="Speaker diarization"
                    onChange={(v) => {
                      setDiarize(v);
                      persistOptions({ diarize: v });
                    }}
                  />
                </SettingRow>
              </div>
              {translationAvailable && (
                <div className="relative">
                  <span
                    aria-hidden
                    className="absolute -left-[21px] top-[22px] size-[7px] rounded-full bg-faint"
                  />
                  <SettingRow
                    title="Translation"
                    desc="Runs last — translates the finished segments into your target languages, keeping the original (server-side MT)."
                    last
                    expand={
                      translateTo.length > 0 ? (
                        <SettingExpand>
                          <TranslationOptionsFields
                            sectionLabels
                            targets={translateTo}
                            onTargetsChange={(next) => {
                              setTranslateTo(next);
                              persistOptions({ translateTo: next });
                            }}
                            mode={translationMode}
                            onModeChange={(m) => {
                              setTranslationMode(m);
                              persistOptions({ translationMode: m });
                            }}
                            model={translationModel}
                            onModelChange={(v) => {
                              setTranslationModel(v);
                              persistOptions({ translationModel: v });
                            }}
                            caps={caps}
                            exclude={language !== "auto" ? language : undefined}
                          >
                            <p className="text-[12px] text-faint">
                              Fluent joins split sentences before translating (timing untouched) ·
                              source auto-detected · karaoke stays on the original
                            </p>
                          </TranslationOptionsFields>
                        </SettingExpand>
                      ) : undefined
                    }
                  >
                    <Toggle
                      checked={translateTo.length > 0}
                      ariaLabel="Translation"
                      onChange={(v) => {
                        if (v) {
                          // Seed: Backend Translation defaults → the caller's
                          // server-side default → English; never the known
                          // source (en→en would be a no-op stage).
                          const src = language !== "auto" ? language : undefined;
                          const seed = (
                            backend?.translationOverrides?.translateTo?.length
                              ? backend.translationOverrides.translateTo
                              : caps?.translate_to_default?.length
                                ? caps.translate_to_default
                                : ["en"]
                          ).filter((c) => c !== src);
                          const next = seed.length ? seed : [src === "en" ? "de" : "en"];
                          setTranslateTo(next);
                          if (translate) {
                            setTranslate(false);
                            setTranslateExclNotice("whisper");
                            persistOptions({ translateTo: next, translate: false });
                          } else {
                            setTranslateExclNotice(null);
                            persistOptions({ translateTo: next });
                          }
                        } else {
                          setTranslateTo([]);
                          setTranslateExclNotice(null);
                          persistOptions({ translateTo: [] });
                        }
                      }}
                    />
                  </SettingRow>
                  {translateExclNotice === "t2t" && (
                    <p className="-mt-2 pb-3 text-[12px] text-warn">
                      Turned off — Translate to English (above) replaces it; the two can't combine.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <DisclosureCard
          open={showOverrides}
          onToggle={() => setShowOverrides((v) => !v)}
          title={
            <>
              Decode overrides
              {Object.keys(runOverrides).length > 0 && (
                <span className="text-faint"> · {Object.keys(runOverrides).length} set for this run</span>
              )}
              {runOverrideProfile && (
                <span className="text-faint"> · server profile set for this run</span>
              )}
            </>
          }
        >
          <p className="mb-4 text-[12.5px] text-dim">
            Only for this run — your Backend and Profile defaults are untouched. Empty = inherit.
          </p>
          <DecodeFields
            value={runOverrides}
            onChange={setRunOverrides}
            inherited={inheritedBaseline}
            serverKind={serverKind}
            canCustomize={caps?.can_request_decode_overrides}
          />
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-3 text-[12px] font-medium text-dim">
              Server override profile{" "}
              <span className="text-faint">· only for this run — empty inherits the backend</span>
            </div>
            <OverrideProfilePicker
              serverUrl={backend ? effectiveServerUrl(backend, settings) : ""}
              backendId={backend?.id ?? ""}
              serverKind={serverKind}
              canRequest={caps?.can_request_override_profile}
              value={runOverrideProfile}
              inheritLabel={
                !backend?.overrideProfile
                  ? "Backend default"
                  : backend.overrideProfile === NO_OVERRIDE_PROFILE
                    ? "Backend default · none"
                    : `Backend default · ${safeDisplayText(backend.overrideProfile, 40)}`
              }
              onChange={(v) => setRunOverrideProfile(v.trim() ? v : "")}
            />
          </div>
        </DisclosureCard>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button variant="accent" disabled={!files.length || busy || !isTauri} onClick={run}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy
            ? "Transcribing…"
            : files.length > 1
              ? `Transcribe ${files.length} ${files.some(isSourceUrl) ? "items" : "files"}`
              : "Transcribe"}
        </Button>
        {busy && queue.length > 1 && (
          <span className="font-mono text-[11px] text-faint">
            {doneCount} of {queue.length} done
          </span>
        )}
        {!isTauri && <span className="text-[12px] text-faint">Available in the desktop app.</span>}
      </div>

      {(() => {
        // Run-detail panel (per the approved design canvas): identity plus an
        // overall pipeline bar segmented at the stage boundaries, then one
        // instrumented row per stage — %, elapsed, ~left, throughput, model +
        // device chips, the decoder's live tail, and the diarizer's current
        // step. "unknown" polls never overwrite a known stage, so the panel
        // only ever moves forward; until the first poll answers, the first
        // stage counts as active. After the run it settles into a completed
        // state: every row a receipt, until the input changes.
        // The COMPLETED panel is pinned to the file whose clocks it shows (the pump's last
        // file): every instrument below comes from per-file stageTimes/stageMeta, so following
        // the clicked row relabelled last-file receipts with another file's name and duration
        // and printed an invented "×realtime". Clicking a row changes only the transcript.
        const lastSettled = settledPanelItem(queue, lastRunPath ?? selectedPath);
        const complete =
          !busy && lastSettled?.status === "done" && Object.keys(stageTimes).length > 0;
        if (!busy && !complete) return null;
        const runningItem = queue.find((it) => it.status === "running") ?? null;
        const panelItem = runningItem ?? (complete ? lastSettled : null);
        // URL items prepend a Download stage to the rail (per-item, so file
        // items in the same run never show it).
        const forUrl =
          panelItem?.kind === "url" ||
          (panelItem ? isSourceUrl(panelItem.path) : false);
        // Text sources run the translation stage alone — per item, so audio
        // files in the same run keep the full pipeline rail.
        const forText =
          panelItem?.kind === "text" ||
          (panelItem && !forUrl ? isTextSourcePath(panelItem.path) : false);
        const stages = railStages(lastOptions, forUrl, forText);
        const active = complete
          ? stages.length
          : activeRailIndex(progress, stageTimes, stages);
        // Requested stages the server jumped over (feature disabled there) —
        // shown as "skipped", never as done, and worth no progress credit.
        const skipped = skippedStages({ progress, stageTimes, lastOptions, forUrl, forText });
        const now = Date.now();
        const fileIdx = queue.findIndex((it) => it.status === "running");
        const overall = complete
          ? 1
          : overallFraction({ queue, progress, stageTimes, lastOptions, forUrl, forText }) ?? 0;
        const starts = Object.values(stageTimes).map((t) => t.start);
        const ends = Object.values(stageTimes).map((t) => t.end ?? t.start);
        const runElapsed = starts.length
          ? (complete ? Math.max(...ends) : now) - Math.min(...starts)
          : 0;
        const audioDur =
          progress?.duration ??
          panelItem?.result?.duration ??
          (panelItem ? urlMeta[panelItem.path]?.durationSec : undefined) ??
          null;
        // Whole-run figures for the completed footer: sum the finished items when the run
        // had several files (the rail's clocks describe only the last one).
        const totals = runTotals(queue);
        const multi = queue.length > 1;
        const shownElapsed = complete && multi && totals.tookMs > 0 ? totals.tookMs : runElapsed;
        const shownAudio = complete && multi && totals.audioSec > 0 ? totals.audioSec : audioDur;
        const overallRt =
          complete && shownAudio && shownElapsed > 0 ? shownAudio / (shownElapsed / 1000) : null;
        const panelUrlMeta = panelItem ? urlMeta[panelItem.path] : undefined;
        const extractorLabel = panelUrlMeta?.extractor
          ? panelUrlMeta.extractor === "Generic"
            ? "direct link"
            : safeDisplayText(panelUrlMeta.extractor, 24)
          : null;
        // Through speakersOf, which falls back to the segments' labels when a backend omits
        // the top-level list — the queue row counts the same way.
        const speakerCount = panelItem?.result ? speakersOf(panelItem.result).length : 0;
        const doneItems = queue.filter((it) => it.status === "done");
        const queuedCount = queue.filter((it) => it.status === "queued").length;
        // Whole-run estimate: the current file's projection plus the average
        // measured wall time of the finished files for each queued one.
        const curLeft = etaMs(overall, runElapsed);
        const tooks = doneItems.map((it) => it.tookMs).filter((t): t is number => !!t);
        const avgTook = tooks.length ? tooks.reduce((a, b) => a + b, 0) / tooks.length : null;
        const runLeft =
          queuedCount > 0 && avgTook !== null && curLeft !== null
            ? curLeft + avgTook * queuedCount
            : null;
        // Effective VAD for this run — labels the "analyzing" phase honestly
        // (per-run override, else the inherited default, else the server's
        // shipped default of on).
        const vadOn = lastOverrides.vad_filter ?? vadInherited ?? true;
        // Timeline strip: segment widths proportional to each stage's share
        // of wall time (measured when finished, estimated ahead), with one
        // axis label anchored below each segment. Skipped stages are absent.
        const timeline = stageTimeline({
          stages, skipped, stageTimes, progress,
          audioDurSec: audioDur ?? null, complete, now,
        });
        const totalMs = timeline.reduce((a, e) => a + e.ms, 0) || 1;
        const stripAvail = Math.max(
          stripW - 2 * Math.max(timeline.length - 1, 0), 0);
        const segPx = timeline.map((e) =>
          Math.max((e.ms / totalMs) * stripAvail, 5));
        const axisLabels = timeline.map((e) => {
          const name = AXIS_NAMES[e.stage];
          let dur = "";
          let extra = "";
          if (e.state === "done") {
            dur = fmtElapsed(e.elapsedMs || e.ms);
            if (complete) extra = `${Math.round((e.ms / totalMs) * 100)}%`;
          } else if (e.state === "active") {
            dur = fmtElapsed(e.elapsedMs);
            if (e.estMs != null) extra = `/ ~${fmtElapsed(e.estMs)}`;
          } else if (e.estMs != null) {
            dur = `~${fmtElapsed(e.estMs)}`;
          }
          return { name, dur, extra };
        });
        const axisPos = axisLayout(
          segPx,
          axisLabels.map((l) =>
            Math.max(
              axisTextWidth(l.name),
              axisTextWidth(l.extra ? `${l.dur} ${l.extra}` : l.dur),
            ) + 3),
          stripW);
        const hasDrop = axisPos.some((p) => p.row === 1);
        return (
          <Card className="mt-4 px-5 py-4">
            <div className="flex items-center gap-3">
              {complete ? (
                <Check className="size-[18px] shrink-0 text-ok" />
              ) : forUrl ? (
                <Link2 className="size-[18px] shrink-0 text-accent" />
              ) : (
                <FileAudio className="size-[18px] shrink-0 text-accent" />
              )}
              <span className="min-w-0 truncate text-[13.5px] font-medium text-text">
                {panelItem
                  ? displayLabel(panelItem.path, panelItem.title ?? panelUrlMeta?.title)
                  : "Preparing…"}
              </span>
              {forUrl && panelItem && (
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {urlHost(panelItem.path)}
                </span>
              )}
              {!complete && audioDur ? (
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {fmtDurationExact(audioDur)} audio
                </span>
              ) : null}
              <span className="flex-1" />
              {complete ? (
                <span className="font-mono text-[18px] font-medium text-ok">done</span>
              ) : (
                <>
                  <span className="font-mono text-[18px] font-medium tabular-nums text-accent">
                    {Math.round(overall * 100)}%
                  </span>
                  <Button variant="default" size="sm" onClick={cancelRun}>
                    Cancel
                  </Button>
                </>
              )}
            </div>

            <div ref={stripBoxRef} className="mt-3.5 flex h-[7px] gap-0.5">
              {timeline.map((e) => (
                <div
                  key={e.stage}
                  className="relative min-w-[5px] overflow-hidden rounded-pill bg-surface-2 transition-[flex-grow] duration-500 motion-reduce:transition-none"
                  style={{
                    flexGrow: e.ms,
                    flexBasis: 0,
                    // Ghost = estimate: a clean hard-stop hatch on the track
                    // color. (A dashed border inside a 7px pill turned the
                    // pattern to mush — crisp beats ornate here.)
                    ...(e.state === "pending"
                      ? {
                          backgroundImage:
                            "repeating-linear-gradient(-45deg, var(--c-line-strong) 0 2px, transparent 2px 6px)",
                        }
                      : {}),
                  }}
                >
                  {e.state !== "pending" && (
                    <div
                      className={cn(
                        "h-full rounded-pill transition-[width] duration-500 motion-reduce:transition-none",
                        e.overrun && "animate-pulse",
                      )}
                      style={{
                        width: `${Math.round((e.state === "done" ? 1 : Math.max(e.fill, 0.02)) * 100)}%`,
                        background: STAGE_COLORS[e.stage],
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className={cn("mt-[5px] flex gap-0.5", hasDrop ? "h-[76px]" : "h-11")}>
              {timeline.map((e, i) => {
                const drop = axisPos[i].row === 1;
                const l = axisLabels[i];
                return (
                  <div
                    key={e.stage}
                    className="relative min-w-[5px]"
                    style={{ flexGrow: e.ms, flexBasis: 0 }}
                  >
                    <span
                      aria-hidden
                      className="absolute left-px top-0 w-px"
                      style={{
                        height: drop ? 39 : 7,
                        background: STAGE_COLORS[e.stage],
                      }}
                    />
                    <div
                      className={cn(
                        // z-[1] + a card-colored halo: a label may extend
                        // over a neighbour's (tall) tick — the text then
                        // occludes the line instead of colliding with it.
                        "absolute z-[1] whitespace-nowrap font-mono text-[10.5px] leading-[1.55] tabular-nums",
                        e.state === "pending" && "opacity-60",
                      )}
                      style={{
                        top: drop ? 41 : 9,
                        left: axisPos[i].offset,
                        background: "var(--c-surface)",
                        boxShadow: "0 0 0 3px var(--c-surface)",
                      }}
                    >
                      <div
                        className={cn(
                          "tracking-[.03em]",
                          e.state === "active" ? "text-text" : "text-dim",
                        )}
                      >
                        {l.name}
                      </div>
                      <div>
                        <span className={e.state === "active" ? "text-accent" : "text-text"}>
                          {l.dur}
                        </span>
                        {l.extra ? <span className="text-faint"> {l.extra}</span> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex items-baseline justify-between font-mono text-[11px] tabular-nums text-faint">
              <span>
                {queue.length > 1 && fileIdx >= 0 ? `file ${fileIdx + 1} of ${queue.length}` : "\u00a0"}
              </span>
              <span>
                {complete ? (
                  <span className="text-dim">
                    {shownAudio
                      ? `${fmtDurationExact(shownAudio)} audio → transcript in ${fmtElapsed(shownElapsed)}`
                      : `finished in ${fmtElapsed(shownElapsed)}`}
                    {overallRt ? (
                      <> · <span className="text-text">{overallRt.toFixed(1)}× realtime overall</span></>
                    ) : null}
                  </span>
                ) : (
                  <>
                    elapsed <span className="text-dim">{fmtElapsed(runElapsed)}</span>
                    {curLeft !== null ? (
                      <> · <span className="text-text">{aboutLeft(curLeft)}</span></>
                    ) : (
                      <> · <span className="text-dim">estimating…</span></>
                    )}
                  </>
                )}
              </span>
            </div>

            <div className="mt-3 border-t border-line">
              {stages.map((st, i) => {
                // Skipped wins over pending too: the server may announce a
                // decline for a stage the rail hasn't reached yet (diarization
                // is declined moments before its slot).
                const state: StepState =
                  skipped.has(st) ? "skipped"
                    : i === active ? "active"
                      : i > active ? "pending" : "done";
                const frac =
                  state === "active" && typeof progress?.progress === "number"
                    ? progress.progress
                    : null;
                const waiting = state === "active" && progress?.stage === "waiting";
                // Inside model.transcribe() before the first segment: audio
                // decode + Silero VAD (used to be misattributed to "waiting").
                const analyzing = state === "active" && progress?.stage === "analyzing";
                // Metadata probe before the download starts — folds onto the
                // Download row as a suffix (railOf maps it there).
                const resolving = state === "active" && progress?.stage === "resolving";
                // Backend transcodes non-wav/flac input for the separator
                // (step=preparing) — show that minute as work, not silence.
                const preparing =
                  st === "separating" && state === "active" && progress?.step === "preparing";
                const time = stageTimes[st];
                const meta = stageMeta[st];
                const stageElapsedMs =
                  state === "active" && time ? now - time.start
                    : state === "done" && time?.end ? time.end - time.start
                      : null;
                const stageLeft =
                  state === "active" && stageElapsedMs !== null ? etaMs(frac, stageElapsedMs) : null;
                // ×-realtime: live from the decoded position; finished stages
                // from the audio duration once the decoder reports it.
                const speed =
                  st === "transcribing" && state === "active" && progress?.position &&
                  stageElapsedMs && stageElapsedMs > 5000
                    ? progress.position / (stageElapsedMs / 1000)
                    : st !== "downloading" && state === "done" && audioDur && stageElapsedMs
                      ? audioDur / (stageElapsedMs / 1000)
                      : null;
                // Download throughput over the ACTUAL transfer window (the
                // row clock folds resolving + model load in — right for
                // elapsed, poison for byte rates), once the rate is stable.
                const dlElapsedMs =
                  st === "downloading" && meta?.dlStart
                    ? (state === "done" && time?.end ? time.end : now) - meta.dlStart
                    : stageElapsedMs;
                const dlSpeed =
                  st === "downloading" && state === "active" &&
                  typeof frac === "number" && progress?.totalBytes &&
                  dlElapsedMs && dlElapsedMs > 2000
                    ? (frac * progress.totalBytes) / (dlElapsedMs / 1000)
                    : null;
                // Live total, else the preview's estimate (marked "~").
                const dlTotal = st === "downloading" ? progress?.totalBytes ?? null : null;
                const dlEst =
                  st === "downloading" && !dlTotal ? panelUrlMeta?.estimatedBytes ?? null : null;
                // Done-row receipt: final bytes captured while the download
                // reported them, and the average rate over the stage.
                const dlBytes =
                  st === "downloading" && state === "done" ? meta?.bytes ?? null : null;
                const dlAvg =
                  dlBytes && dlElapsedMs && dlElapsedMs > 0
                    ? dlBytes / (dlElapsedMs / 1000)
                    : null;
                // VAD both halves: kept fraction from the live poll.
                const vr =
                  st === "transcribing" && typeof progress?.vadRetained === "number"
                    ? progress.vadRetained
                    : null;
                const vadWarn = vr !== null && vr < 0.3;
                return (
                  <div
                    key={st}
                    className={cn(
                      "flex gap-3.5 border-b border-line py-3.5 last:border-b-0",
                      state === "pending" && "opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11px]",
                        state === "pending" && "bg-surface-2 text-faint",
                        // Dashed ring, no fill: the slot exists, nothing ran
                        // in it — deliberately borrows neither success nor
                        // error styling.
                        state === "skipped" &&
                          "border-[1.5px] border-dashed border-faint/70 text-faint",
                      )}
                      // Done / active rows wear their stage's timeline-strip
                      // hue so the rail and the overall bar read as one system.
                      style={
                        state === "done" || state === "active"
                          ? {
                              color: STAGE_COLORS[st],
                              background: `color-mix(in srgb, ${STAGE_COLORS[st]} 16%, transparent)`,
                            }
                          : undefined
                      }
                    >
                      {state === "done" ? (
                        <Check className="size-3.5" />
                      ) : state === "skipped" ? (
                        <ChevronsRight className="size-3.5" />
                      ) : state === "active" && frac === null ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-[13px] font-medium",
                            state === "active" ? "text-text" : "text-dim",
                          )}
                        >
                          {RAIL_NAMES[st]}
                          {waiting && (
                            <span className="font-normal text-faint"> — waiting for a server slot…</span>
                          )}
                          {analyzing && (
                            <span className="font-normal text-faint">
                              {" "}— {vadOn ? "skipping silence…" : "analyzing audio…"}
                            </span>
                          )}
                          {resolving && (
                            <span className="font-normal text-faint"> — resolving link…</span>
                          )}
                          {preparing && (
                            <span className="font-normal text-faint"> — preparing audio…</span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                          {state === "done" && (
                            <>
                              <span style={{ color: STAGE_COLORS[st] }}>done</span>
                              {stageElapsedMs !== null
                                ? ` · ${fmtElapsed(stageElapsedMs)}`
                                : ""}
                            </>
                          )}
                          {state === "skipped" && <span className="text-warn">skipped</span>}
                          {frac !== null && (
                            <span className="text-text">{Math.round(frac * 100)}%</span>
                          )}
                          {st === "diarizing" && state === "active" && progress?.step
                            ? ` · ${safeDisplayText(progress.step)}`
                            : ""}
                          {st === "transcribing" && state === "active" && progress?.position && audioDur
                            ? ` · ${fmtDurationExact(progress.position)} of ${fmtDurationExact(audioDur)} audio`
                            : ""}
                          {st === "downloading" && state === "active" && typeof frac === "number"
                            ? dlTotal
                              ? ` · ${fmtBytes(frac * dlTotal)} of ${fmtBytes(dlTotal)}`
                              : dlEst
                                ? ` · of ~${fmtBytes(dlEst)}`
                                : ""
                            : ""}
                        </span>
                      </div>
                      {RAIL_DESCRIPTIONS[st] && state === "pending" && (
                        <div className="mt-0.5 text-[12px] text-dim">{RAIL_DESCRIPTIONS[st]}</div>
                      )}
                      {state === "skipped" && (
                        <div className="mt-0.5 text-[12px] text-dim">
                          <span className="text-warn">Not enabled on this server</span>
                          {SKIPPED_EXPLANATIONS[st]}
                        </div>
                      )}
                      {frac !== null && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-pill bg-surface-2">
                          <div
                            className="h-full rounded-pill transition-[width] duration-500"
                            style={{
                              width: `${Math.max(2, Math.round(frac * 100))}%`,
                              background: STAGE_COLORS[st],
                            }}
                          />
                        </div>
                      )}
                      {(meta || stageElapsedMs !== null ||
                        (st === "downloading" && extractorLabel)) && (
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <span className="flex flex-wrap gap-1.5">
                            {/* Source pill: the extractor that resolved the
                                link travels with the run (Generic reads as
                                "direct link"). */}
                            {st === "downloading" && extractorLabel && (
                              <span className="rounded-pill bg-accent-soft px-2 py-px font-mono text-[10px] uppercase tracking-label text-accent">
                                {extractorLabel}
                              </span>
                            )}
                            {st === "downloading" && panelUrlMeta?.format && (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                {safeDisplayText(panelUrlMeta.format, 32)}
                              </span>
                            )}
                            {meta?.model && (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                {safeDisplayText(meta.model)}
                              </span>
                            )}
                            {meta?.device && (
                              <span
                                className={cn(
                                  "rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px]",
                                  meta.device === "cuda" ? "text-ok" : "text-warn",
                                )}
                              >
                                {safeDisplayText(meta.device)}
                                {meta.compute ? ` · ${safeDisplayText(meta.compute)}` : ""}
                              </span>
                            )}
                            {/* Receipts: a finished stage keeps its evidence
                                as metric chips — number emphasized, no live
                                leftovers. */}
                            {state === "done" && dlBytes ? (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                <span className="font-medium text-text">{fmtBytes(dlBytes)}</span>
                              </span>
                            ) : null}
                            {state === "done" && dlAvg ? (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                <span className="font-medium text-text">{fmtBytes(dlAvg)}/s</span> avg
                              </span>
                            ) : null}
                            {state === "done" && st === "separating" && (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                vocals isolated
                              </span>
                            )}
                            {state === "done" && speed ? (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                <span className="font-medium text-text">{speed.toFixed(1)}×</span> realtime avg
                              </span>
                            ) : null}
                            {/* VAD receipt on the finished row: the win (or
                                the warning) in one chip; the live run shows
                                the split bar below instead. */}
                            {state === "done" && vr !== null && audioDur && vr < 0.999 && (
                              vadWarn ? (
                                <span className="rounded-md bg-warn/10 px-2 py-0.5 font-mono text-[10.5px] text-warn">
                                  kept {Math.round(vr * 100)}% — mostly silence
                                </span>
                              ) : (
                                <span className="rounded-md bg-ok/10 px-2 py-0.5 font-mono text-[10.5px] text-ok">
                                  {fmtDurationExact(audioDur * (1 - vr))} silence skipped
                                </span>
                              )
                            )}
                            {state === "done" && st === "diarizing" && speakerCount > 0 && (
                              <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                <span className="font-medium text-text">{speakerCount}</span>
                                {speakerCount === 1 ? " speaker" : " speakers"}
                              </span>
                            )}
                            {/* Neutral receipt of a user-chosen speaker mode —
                                documents what the run did, same tone as every
                                other rail meta (the choice is explicit in the
                                Auto/Count/Range segment now, so no warning). */}
                            {st === "diarizing" &&
                              state !== "pending" &&
                              state !== "skipped" &&
                              ((lastOptions?.numSpeakers ?? 0) > 0 ||
                                (lastOptions?.minSpeakers ?? 0) > 0) && (
                                <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
                                  {(lastOptions?.numSpeakers ?? 0) > 0
                                    ? `count set to ${lastOptions?.numSpeakers}`
                                    : `range ${lastOptions?.minSpeakers}–${lastOptions?.maxSpeakers}`}
                                </span>
                              )}
                          </span>
                          {state !== "done" && (
                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                              {stageElapsedMs !== null ? `running ${fmtElapsed(stageElapsedMs)}` : ""}
                              {speed ? ` · ${speed.toFixed(1)}× realtime` : ""}
                              {dlSpeed ? ` · ${fmtBytes(dlSpeed)}/s` : ""}
                              {stageLeft !== null ? ` · ${aboutLeft(stageLeft)}` : ""}
                            </span>
                          )}
                        </div>
                      )}
                      {/* VAD split bar (live): a composition readout of the
                          whole timeline — muted kept audio, hatched removed
                          silence. Deliberately thin, flat and dim so it
                          can't be mistaken for the stage progress bar above
                          (thick, saturated, rounded = progress; hairline
                          split = composition, same grammar as the storage
                          bar in Settings). */}
                      {state === "active" && vr !== null && audioDur ? (
                        <div className="mt-2.5">
                          <div className="flex h-[3px] gap-0.5">
                            <div
                              className="rounded-[1px] bg-ok/40"
                              style={{ width: `${Math.max(2, Math.round(vr * 100))}%` }}
                            />
                            {vr < 0.995 && (
                              <div
                                className="rounded-[1px]"
                                style={{
                                  width: `${Math.max(2, Math.round((1 - vr) * 100))}%`,
                                  background:
                                    "repeating-linear-gradient(-45deg, var(--c-line-strong) 0 3px, transparent 3px 6px)",
                                }}
                              />
                            )}
                          </div>
                          <div className="mt-1 flex items-baseline justify-between font-mono text-[10.5px] tabular-nums">
                            <span className={vadWarn ? "text-warn" : "text-faint"}>
                              <span className={vadWarn ? undefined : "text-ok"}>
                                kept {fmtDurationExact(audioDur * vr)} ({Math.round(vr * 100)}%)
                              </span>
                              {" · "}skipped {fmtDurationExact(audioDur * (1 - vr))} silence
                            </span>
                            <span className="text-faint">VAD</span>
                          </div>
                        </div>
                      ) : null}
                      {(st === "transcribing" || st === "translating") && state === "active" && progress?.lastText && (
                        <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-1.5">
                          <span className="size-[7px] shrink-0 rounded-full bg-live" />
                          {progress.position ? (
                            <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                              {fmtTimestamp(progress.position)}
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate text-[12px] text-dim">
                            {safeDisplayText(progress.lastText)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {queue.length > 1 && (
              <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3 font-mono text-[11px] tabular-nums text-faint">
                <span>
                  {doneItems.length} done · {queuedCount} queued
                </span>
                {runLeft !== null && (
                  <span>
                    whole run: <span className="text-text">{aboutLeft(runLeft)}</span>
                  </span>
                )}
              </div>
            )}
          </Card>
        );
      })()}

      {queue.length > 1 && (
        <Card className="mt-6 overflow-hidden py-1">
          {/* Master list of the run's files. Selection lives on the ROW (rail
              + wash + filename weight), not on a button label — the transcript
              panel below silently follows it, so which file is open must read
              at a glance. Finished rows are options: click anywhere, Enter/
              Space, or ↑/↓ across the finished set. */}
          <div
            role="listbox"
            aria-label="Transcribed files"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const doneItems = queue.filter((q) => q.status === "done");
              if (!doneItems.length) return;
              e.preventDefault();
              const idx = doneItems.findIndex((q) => q.path === selectedPath);
              const next =
                e.key === "ArrowDown"
                  ? doneItems[Math.min(doneItems.length - 1, idx + 1)]
                  : doneItems[Math.max(0, (idx < 0 ? doneItems.length : idx) - 1)];
              selectPath(next.path);
              // role="listbox" with roving tabIndex: the active option must own DOM focus,
              // or the ring and the screen reader stay on the row the user left.
              e.currentTarget
                .querySelector<HTMLElement>(`[data-qpath="${CSS.escape(next.path)}"]`)
                ?.focus();
            }}
          >
            {queue.map((it, i) => {
              const viewable = it.status === "done";
              const isSel = viewable && it.path === selectedPath;
              const view = () => selectPath(it.path);
              return (
                <div
                  key={it.path}
                  data-qpath={it.path}
                  role="option"
                  aria-selected={viewable ? isSel : undefined}
                  aria-disabled={!viewable || undefined}
                  tabIndex={viewable ? 0 : undefined}
                  onClick={viewable ? view : undefined}
                  onKeyDown={
                    viewable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            view();
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "relative flex items-center gap-3 px-5 py-3",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                    i < queue.length - 1 && "border-b border-line",
                    viewable && "cursor-pointer hover:bg-text/[0.03]",
                    isSel && "bg-accent/[0.06] hover:bg-accent/[0.08]",
                  )}
                >
                  {isSel && (
                    <span
                      aria-hidden
                      className="absolute inset-y-2 left-0 w-[2.5px] rounded-pill bg-accent"
                    />
                  )}
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full",
                      it.status === "done" && "bg-ok/15 text-ok",
                      it.status === "running" && "bg-think/15 text-think",
                      it.status === "failed" && "bg-rec/15 text-rec",
                      (it.status === "queued" || it.status === "cancelled") && "bg-surface-2 text-faint",
                    )}
                  >
                    {it.status === "done" ? (
                      <Check className="size-3.5" />
                    ) : it.status === "running" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : it.status === "failed" ? (
                      <X className="size-3.5" />
                    ) : (
                      <span className="font-mono text-[11px]">{i + 1}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px]",
                      it.status === "cancelled"
                        ? "text-faint line-through"
                        : viewable && !isSel
                          ? "text-dim"
                          : "text-text",
                    )}
                  >
                    {displayLabel(it.path, it.title ?? urlMeta[it.path]?.title)}
                    {(it.kind === "url" || isSourceUrl(it.path)) && (
                      <span className="ml-2 font-mono text-[11px] text-faint">
                        {urlHost(it.path)}
                      </span>
                    )}
                  </span>
                  {it.status === "done" && it.result && (
                    <span className="font-mono text-[11px] text-faint">
                      {it.result.duration
                        ? it.result.duration < 60
                          ? `${it.result.duration.toFixed(0)}s`
                          : fmtDurationExact(it.result.duration)
                        : ""}
                      {it.result.language ? ` · ${it.result.language}` : ""}
                      {(() => {
                        const spk = speakersOf(it.result).length;
                        return spk ? ` · ${spk} ${spk === 1 ? "speaker" : "speakers"}` : "";
                      })()}
                    </span>
                  )}
                  {it.status === "running" && (
                    <span className="font-mono text-[11px] text-think">
                      {/* The whole-pipeline number the panel shows, not the stage-local
                          fraction: the two are on screen together and disagreed. */}
                      {/* A bare 0 (no server progress yet — a standard server is never
                          polled) shows the stage word: the row's only liveness signal. */}
                      {typeof runningOverall === "number" && runningOverall > 0
                        ? `${Math.round(runningOverall * 100)}%`
                        : stageLabel(progress).toLowerCase()}
                    </span>
                  )}
                  {it.status === "cancelled" && (
                    <span className="font-mono text-[11px] text-faint">cancelled</span>
                  )}
                  {it.status === "failed" && (
                    <>
                      <span
                        className="max-w-[240px] truncate font-mono text-[11px] text-rec"
                        title={stripControlChars(it.error ?? "")}
                      >
                        {stripControlChars(it.error ?? "failed")}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => retry(it.path)} disabled={busy}>
                        <RotateCcw className="size-3.5" /> Retry
                      </Button>
                    </>
                  )}
                  {isSel && (
                    <span className="shrink-0 rounded-pill bg-accent-soft px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-label text-accent">
                      Viewing
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {queue.length === 1 && queue[0].status === "failed" && (
        <Notice className="mt-6">{stripControlChars(queue[0].error ?? "Transcription failed.", 500)}</Notice>
      )}
    </>
  );

  const viewer =
    result && selectedPath ? (
      <TranscriptViewer
        result={result}
        path={selectedPath}
        mediaPath={selected?.mediaPath}
        createdAt={selected?.createdAt}
        onClose={busy ? undefined : closeRecord}
        overlayKey={openRecordId ?? undefined}
        fileLabel={
          queue.length > 1 || isSourceUrl(selectedPath)
            ? displayLabel(selectedPath, selected?.title ?? urlMeta[selectedPath]?.title)
            : undefined
        }
        fill={studio}
        className={studio ? undefined : "mt-6"}
      />
    ) : null;

  const resultNotices = (
    <>
      {/* VAD ate the file: the server's silence filter kept under 30% of the
          audio (the backend's own "likely cause: VAD ate audio" heuristic).
          durationAfterVad is only sent when the filter actually ran. */}
      {result?.durationAfterVad !== undefined &&
        selected &&
        result.duration &&
        result.durationAfterVad < 0.3 * result.duration &&
        vadNoticeDismissed !== selected.path && (
          <Notice className="mt-3">
            <div className="font-medium">Silence skipping removed most of this file</div>
            <div className="mt-0.5">
              Only {fmtDurationExact(result.durationAfterVad)} of {fmtDurationExact(result.duration)} was
              treated as speech. If words are missing, run it again without the filter.
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="default"
                size="sm"
                disabled={busy}
                onClick={() => retryWithoutVad(selected.path)}
              >
                Retry without skipping
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVadNoticeDismissed(selected.path)}
              >
                Dismiss
              </Button>
            </div>
          </Notice>
        )}

      {result?.warnings && result.warnings.length > 0 && (
        <Notice className="mt-3">
          {result.warnings.slice(0, 10).map((w, i) => (
            <div key={i}>{safeDisplayText(w, 300)}</div>
          ))}
        </Notice>
      )}

      {result?.overridesIgnored && result.overridesIgnored.length > 0 && (
        <Notice className="mt-3">
          The server ignored {result.overridesIgnored.length} override
          {result.overridesIgnored.length === 1 ? "" : "s"} (locked by the server admin):{" "}
          <span className="font-mono text-[12px]">
            {result.overridesIgnored.slice(0, MAX_IGNORED_SHOWN).join(", ")}
          </span>
          {result.overridesIgnored.length > MAX_IGNORED_SHOWN ? " …" : ""}.
        </Notice>
      )}
    </>
  );

  // Recent transcripts — kept in ONE stable slot in every state: end of the
  // rail in studio, between the config and the transcript in stacked. It used
  // to sit BELOW the stacked viewer, so picking a record pushed the list a
  // full transcript-card down — reading as "the history disappeared". Above
  // the viewer, opening a transcript changes nothing about the elements
  // before it. A run that just finished appears here too (the history store
  // is reactive). Full list: History screen.
  const recentStrip =
    recentRecords.length > 0 ? (
      <Card className="mt-6 overflow-hidden py-1">
          <div className="flex items-baseline gap-2 px-5 py-2">
            <span className="font-mono text-[11px] uppercase tracking-label text-faint">
              recent
            </span>
            <span className="flex-1" />
            <Link to="/history" className="ring-signal rounded text-[12px] text-accent">
              All history →
            </Link>
          </div>
          {recentRecords.map((rec, i) => {
            // Same-URL records share their path — the id is the only honest
            // "this is the one on the workbench" marker.
            const isOpen = rec.id === openRecordId;
            return (
              <div
                key={rec.id}
                role="button"
                tabIndex={busy ? -1 : 0}
                aria-disabled={busy || undefined}
                title={busy ? "Finish or cancel the run to open a past transcript" : undefined}
                aria-current={isOpen || undefined}
                onClick={() => {
                  if (!busy) openHistoryRecord(rec);
                }}
                onKeyDown={(e) => {
                  if (!busy && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openHistoryRecord(rec);
                  }
                }}
                className={cn(
                  "flex items-center gap-3 px-5 py-2.5",
                  busy ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-text/[0.03]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                  i < recentRecords.length - 1 && "border-b border-line",
                  isOpen && "bg-accent-soft/40",
                )}
              >
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
                  <Check className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                  {safeDisplayText(rec.sourceName, 120)}
                </span>
                {isOpen && (
                  <span className="shrink-0 rounded-pill bg-accent-soft px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-label text-accent">
                    Viewing
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {recentMeta(rec)}
                </span>
              </div>
            );
          })}
      </Card>
    ) : null;

  // ONE tree for both arrangements, switched by className only: stacked is
  // the centered column, studio puts config + queue in a self-scrolling left
  // rail with the transcript as a full-height pane beside it. Because the
  // element positions never change, React keeps every node alive across a
  // layout switch (or an auto-switch on resize) — playback, scroll position
  // and edit state in the transcript viewer all survive.
  return (
    <div
      className={
        studio
          ? "page page-dense flex h-full min-h-0 gap-7 pb-8 pt-6"
          : "page page-form"
      }
    >
      <div
        className={studio ? "min-h-0 shrink-0 overflow-y-auto overscroll-contain pb-4 pr-1.5" : undefined}
        style={studio ? { width: railPx } : undefined}
      >
        {header}
        {configSections}
        {studio && recentStrip}
      </div>
      {studio && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the settings column"
          aria-valuemin={STUDIO_RAIL_MIN}
          aria-valuemax={railMax}
          aria-valuenow={railPx}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={onRailPointerDown}
          onKeyDown={onRailKeyDown}
          onDoubleClick={() => persistOptions({ studioRailPx: STUDIO_RAIL_DEFAULT })}
          className="group -mx-3 flex w-6 shrink-0 cursor-col-resize justify-center outline-none"
        >
          <i className={cn("block w-px rounded-full bg-line transition-colors group-hover:bg-accent group-focus-visible:bg-accent", railDrag !== null && "bg-accent")} />
        </div>
      )}
      <div className={studio ? "flex min-h-0 min-w-0 flex-1 flex-col" : undefined}>
        {!studio && recentStrip}
        {viewer ??
          (studio ? (
            <Card className="grid flex-1 place-items-center border-dashed bg-surface/40">
              <div className="px-8 text-center">
                <div className="text-[14px] text-text">The transcript opens here</div>
                <div className="mt-1 text-[12.5px] text-dim">
                  Pick files and run them on the left — the result shows side by side.
                </div>
              </div>
            </Card>
          ) : null)}
        {/* The viewer surfaces runs under openRecordId OR selectedPath —
            everything else is "elsewhere". */}
        <OtherTranslateRuns excludeKeys={[openRecordId, selectedPath]} />
        {resultNotices}
      </div>
    </div>
  );
}
