// History: one day-bucketed timeline for BOTH record kinds — file
// transcriptions and dictation sessions — filtered by an All/Files/Links/Text/Dictations
// segment (the call-log pattern) plus "dictated into" app chips. File rows
// open the full workbench; dictation rows expand INLINE: full text, the saved
// recording playable in place, Copy as the main action, and "Open in
// workbench" to re-run the recording through batch transcription (word
// timestamps → karaoke). Search is global; when the active segment hides
// matches, a banner names them (NN/g scoped-search guidance).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { screenEyebrow, screenTitle } from "@/lib/screenRegistry";
import { useNavigate } from "react-router-dom";
import { Check, ChevronUp, Copy, Download, ExternalLink, FileAudio, FileText, Film, Link2, Mic, MicOff, Pause, Play, RotateCcw, Search, Trash2, X, History as HistoryIcon } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  LangTag,
  Notice,
  PageHeader,
  RouteBadge,
  Segmented,
  TextInput,
} from "@/components/ui";
import { useApp } from "@/lib/store";
import { fmtDuration, fmtFull, fmtTimestamp, plural } from "@/lib/format";
import { seekKeyTarget } from "@/lib/seekKeys";
import { pickExportPath, readMediaFile, revealSaved, saveTextFile } from "@/lib/api";
import {
  appChipLabel, appLabel, currentRecord, deleteRecord, loadHistory, recordEditedResult, recordText, recordTracks, recordTranslationTexts,
  useTranscriptHistory, type TranscriptRecord,
} from "@/lib/transcript/transcriptHistory";
import { addFiles, openHistoryRecord, useTranscribeRun } from "@/lib/transcribeRun";
import {
  EXPORT_EXTENSIONS, exportOptionsFor, generateExports, speakerOrder,
  type ExportFormat,
} from "@/lib/transcript/transcriptFormats";
import { authoredChipTag } from "@/lib/profileTag";
import { profileDisplayName, stripControlChars, safeDisplayText } from "@/lib/sanitize";
import { backendLabelById } from "@/lib/backends";
import { langText, langTexts } from "@/lib/languages";
import { shortModelName } from "@/lib/inherit";
import { urlHost } from "@/lib/urlSource";
import { derivePickedStem, exportStem, isVideoSourcePath, linkServerAudioLive, revealAfterSaveOn, withTrackSites } from "@/lib/transcript/mediaExport";
import { readTrackPrefs, trackOrder, transcriptTracks } from "@/lib/transcript/exportTracks";
import { cueOptionsOf } from "@/lib/transcript/cueSplit";
import { displayToggles, patchTranscribe } from "@/lib/useDisplayToggles";
import { cn } from "@/lib/cn";
import { releaseDetachedMedia } from "@/lib/mediaElement";
import { dayBuckets, startOfDay } from "@/lib/historyBuckets";

// Hoisted formatter: toLocale*String with options builds a fresh
// Intl.DateTimeFormat per call, and this runs per record on every keystroke.
const TIME_FMT = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME_FMT.format(d);
}

const isDictation = (r: TranscriptRecord) => r.kind === "dictation";
/** The "dictated into" chip id: grouping, pinned-chip lookup and filter must share it. */
const appKey = (r: TranscriptRecord) => r.appId ?? appLabel(r);

/** A dictation's `translationTarget` (the session's targets joined ", ") as the row shows it:
 *  each code by langText, so a joiner-only code drops out of the list and an all-blank list
 *  reads empty for the caller's fallback wording. Not repaired on load, so a non-string reads
 *  empty too. */
const targetsText = (v: unknown, max: number): string =>
  safeDisplayText(langTexts((typeof v === "string" ? v : "").split(", ")).join(", "), max).trim();

type Haystack = { name: string; appId: string; text: string };

/** A record's search haystack, memoised in `cache` by record identity.
 *  upsertRecord reuses untouched record objects and every writer replaces a
 *  changed one, so an upsert only re-derives the record it changed — not every
 *  entry's 20 000-char text. The cache is owned by the mounted History screen
 *  (not this module), so the lowercased copies die with the page instead of
 *  living as long as the app-lifetime history store's records. */
function haystackOf(r: TranscriptRecord, cache: WeakMap<TranscriptRecord, Haystack>): Haystack {
  const hit = cache.get(r);
  if (hit) return hit;
  // The translated text a session injected, and a file/link/text run's translated
  // tracks, are shown and copied, so they are searchable too —
  // type-guarded and bounded, the file is not validated on load.
  const translated = typeof r.translatedText === "string" ? "\n" + r.translatedText.slice(0, 20_000) : "";
  const fileTr = recordTranslationTexts(r, 20_000)
    .map((v) => "\n" + v)
    .join("");
  const h: Haystack = {
    name: r.sourceName.toLowerCase(),
    appId: (r.appId ?? "").toLowerCase(),
    text: (recordText(r, 20_000) + translated + fileTr).toLowerCase(),
  };
  cache.set(r, h);
  return h;
}

type Segment = "all" | "file" | "url" | "text" | "dictation";

/** The History view's memory across navigation — filters, search, and the
 *  list's scroll position all survive leaving the page (component state
 *  dies with the route; this module object doesn't). */
const viewMemory: {
  query: string;
  segment: Segment;
  appFilter: string | null;
  scrollTop: number;
} = { query: "", segment: "all", appFilter: null, scrollTop: 0 };

/** The last label each "dictated into" chip was shown with: the pinned chip falls back to it once
 *  no record carries its key any more (its last dictation deleted or swept), instead of the raw
 *  key — which cannot be relabelled from the key alone (an appLabel key may be a dotted title).
 *  Module-level like viewMemory.appFilter, so the name also survives leaving and reopening the
 *  page; bounded by the distinct app keys seen. */
const chipLabelMemory = new Map<string, string>();

/** Inline player for a dictation's saved .wav. Loads via readMediaFile → blob
 *  URL (the asset protocol can't feed WebKitGTK's media stack; blob: is in the
 *  CSP). A missing/expired file degrades to a one-line note, not an error. */
function RecordingPlayer({ path }: { path: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [len, setLen] = useState(0);
  const [rate, setRate] = useState(1);
  // Keeps audioRef and empties the element when it detaches (path change,
  // row collapse, unmount): a detached element otherwise holds the whole
  // decoded WAV. Stable, so it is not released and re-attached per render.
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el;
    if (!el) return;
    return () => {
      if (audioRef.current === el) audioRef.current = null;
      releaseDetachedMedia(el);
    };
  }, []);

  useEffect(() => {
    let stale = false;
    let url: string | null = null;
    // Drop the previous recording's URL first: the cleanup below revokes it,
    // and the element must not keep pointing at a dead blob while the next
    // file loads (null also unmounts it, which releases it).
    setSrc(null);
    readMediaFile(path)
      .then((buf) => {
        if (stale) return;
        url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        setSrc(url);
      })
      .catch((e) => {
        if (stale) return;
        // The over-cap refusal is not a missing file: say so instead of "removed by retention".
        setTooBig(String(e).includes("too large to buffer"));
        setGone(true);
      });
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (gone) {
    return (
      <div className="mt-3 text-[12px] text-faint">
        {tooBig
          ? "Audio too large to play here — open the recording from the audio folder (Settings → Recording & history → Audio folder, dictations subfolder)."
          : "Audio unavailable — removed by retention, or recordings were off."}
      </div>
    );
  }
  if (!src) return null;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };
  const seekTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !len) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    a.currentTime = frac * len;
    setCur(frac * len);
  };

  return (
    <div className="mt-3 flex h-9 items-center gap-3 rounded-xl border border-line bg-surface-2 px-3">
      <audio
        ref={attachAudio}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setLen(e.currentTarget.duration)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="ring-signal grid size-6 shrink-0 place-items-center rounded-md text-accent"
      >
        {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
      </button>
      {/* A clock beside a seek bar uses the workbench transport's format: fmtDuration rounds to
          whole minutes above 60 s, so it reads ahead of the audio ("4m" at 3:31). */}
      <span className="font-mono text-[11px] text-dim">{fmtTimestamp(cur)}</span>
      <div
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(len)}
        aria-valuenow={Math.round(cur)}
        tabIndex={0}
        className="relative h-4 flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e);
        }}
        onKeyDown={(e) => {
          // The shared slider contract (arrows, Page, Home/End, Space), as the transcript viewer's.
          const a = audioRef.current;
          if (!a) return;
          const next = seekKeyTarget(e.key, a.currentTime, len || 0, e.shiftKey);
          if (next === null) return;
          e.preventDefault();
          // Space toggles once per press: a held key auto-repeats.
          if (next === "toggle") {
            if (!e.repeat) toggle();
          } else {
            a.currentTime = next;
            setCur(next);
          }
        }}
      >
        <div className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-line" />
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
          style={{ width: `${len ? (cur / len) * 100 : 0}%` }}
        />
        <div
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text"
          style={{ left: `${len ? (cur / len) * 100 : 0}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-faint">{fmtTimestamp(len)}</span>
      <button
        type="button"
        onClick={cycleRate}
        className="ring-signal rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-dim hover:text-text"
        aria-label="Playback speed"
      >
        {rate}×
      </button>
    </div>
  );
}

export default function History() {
  const navigate = useNavigate();
  const records = useTranscriptHistory((s) => s.records);
  const loaded = useTranscriptHistory((s) => s.loaded);
  // The listing failed: `loaded` is true anyway, so without this the screen reads as empty
  // (or as complete with only this session's records).
  const loadFailed = useTranscriptHistory((s) => s.loadFailed);
  // Retry's own feedback: a listing that fails again leaves the notice exactly as it was.
  const [retrying, setRetrying] = useState(false);
  const running = useTranscribeRun((s) => s.running);
  const settings = useApp((s) => s.settings);
  const backends = useApp((s) => s.backends);
  const [query, setQuery] = useState(viewMemory.query);
  const [segment, setSegment] = useState<Segment>(viewMemory.segment);
  const [appFilter, setAppFilter] = useState<string | null>(viewMemory.appFilter);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Quick export's failure, per record — the dialog already confirmed a save,
  // so a silent no-op (or a half-written multi-file set) must not look like one.
  // A Map, not a record: a wire id like "__proto__" needs no own-property guard.
  const [exportErrors, setExportErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const copyTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Local midnight of today, re-read when midnight passes so a History left
  // open overnight moves yesterday's entries out of "Today".
  const [todayStart, setTodayStart] = useState(() => startOfDay(new Date()));
  useEffect(() => {
    let t: number | undefined;
    // Self-rescheduling: a fire that still finds the same day (clock stepped back, a
    // zone moved west) re-arms for the recomputed midnight instead of going quiet.
    const arm = () => {
      const next = new Date(startOfDay(new Date()));
      next.setDate(next.getDate() + 1);
      t = window.setTimeout(() => {
        const s = startOfDay(new Date());
        if (s !== todayStart) setTodayStart(s);
        else arm();
      }, Math.max(0, next.getTime() - Date.now()) + 1000);
    };
    arm();
    // Timers run on a clock that stops during suspend, so after an overnight
    // sleep the fire lands hours late — re-read the day on wake/focus too.
    const recheck = () => {
      const s = startOfDay(new Date());
      if (s !== todayStart) setTodayStart(s);
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [todayStart]);

  useEffect(() => {
    void loadHistory();
  }, []);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => {
    viewMemory.query = query;
    viewMemory.segment = segment;
    viewMemory.appFilter = appFilter;
  }, [query, segment, appFilter]);
  // The scroll position of the app's <main> is restored on mount and
  // captured on unmount (the container itself persists across routes, so
  // without this the list opened wherever the previous page left it). A
  // layout effect: its cleanup runs before the route's DOM is swapped — a
  // passive cleanup would read scrollTop already clamped to the (possibly
  // shorter) next page.
  useLayoutEffect(() => {
    const main = rootRef.current?.closest("main");
    if (main) main.scrollTop = viewMemory.scrollTop;
    return () => {
      if (main) viewMemory.scrollTop = main.scrollTop;
    };
  }, []);

  // Per-mount haystack cache, filled lazily: browsing without searching builds none.
  const [haystackCache] = useState(() => new WeakMap<TranscriptRecord, Haystack>());

  // Search first (global — every kind, names AND text), THEN the segment/app
  // facets, so hidden matches can be counted and surfaced.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const h = haystackOf(r, haystackCache);
      return h.name.includes(q) || h.appId.includes(q) || h.text.includes(q);
    });
  }, [records, query, haystackCache]);

  const fileMatches = useMemo(
    () => searched.filter((r) => !isDictation(r) && r.kind !== "url" && r.kind !== "text"),
    [searched],
  );
  const linkMatches = useMemo(() => searched.filter((r) => r.kind === "url"), [searched]);
  const textMatches = useMemo(() => searched.filter((r) => r.kind === "text"), [searched]);
  const dictMatches = useMemo(() => searched.filter(isDictation), [searched]);

  // "dictated into" chips: top apps across the (searched) dictations.
  const apps = useMemo(() => {
    const counts = new Map<string, { label: string; n: number }>();
    for (const r of dictMatches) {
      const key = appKey(r);
      const cur = counts.get(key);
      if (cur) cur.n++;
      else counts.set(key, { label: appChipLabel(r), n: 1 });
    }
    for (const [id, v] of counts) chipLabelMemory.set(id, v.label);
    const top = [...counts.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);
    // The picked app keeps its chip even when the search leaves it out of the top six (or
    // with no match at all), so the page never says "for this app" without naming it.
    if (appFilter && !top.some((a) => a.id === appFilter)) {
      const src = records.find((r) => isDictation(r) && appKey(r) === appFilter);
      if (src) chipLabelMemory.set(appFilter, appChipLabel(src));
      const pinned = {
        id: appFilter,
        label: src ? appChipLabel(src) : (chipLabelMemory.get(appFilter) ?? appFilter),
        n: counts.get(appFilter)?.n ?? 0,
      };
      if (top.length >= 6) top[top.length - 1] = pinned;
      else top.push(pinned);
    }
    return top;
  }, [dictMatches, appFilter, records]);

  const visible = useMemo(() => {
    let out =
      segment === "file" ? fileMatches
        : segment === "url" ? linkMatches
          : segment === "text" ? textMatches
            : segment === "dictation" ? dictMatches
              : searched;
    if (appFilter && segment === "dictation") {
      out = out.filter((r) => appKey(r) === appFilter);
    }
    return out;
  }, [searched, fileMatches, linkMatches, textMatches, dictMatches, segment, appFilter]);

  // Matches the active facets hide (never silently — NN/g scoped search). Derived from
  // `visible`, so the app chip counts too: the banner's two numbers always add up to
  // `searched.length`.
  const hiddenMatches = query.trim() ? searched.length - visible.length : 0;

  // One group per label (dayBuckets), so the label is a unique key.
  const buckets = useMemo(() => dayBuckets(visible, todayStart), [visible, todayStart]);

  const dictationOff = settings.transcribe?.keepDictationHistory === false;

  const open = (rec: TranscriptRecord) => {
    if (openHistoryRecord(rec)) navigate("/transcribe");
  };

  const retry = (rec: TranscriptRecord) => {
    if (running) return;
    addFiles([rec.sourcePath]);
    navigate("/transcribe");
  };

  /** Dictation → workbench: the recording is just an audio file, so batch
   *  transcription (word timestamps) gives it the full karaoke treatment. */
  const openRecordingInWorkbench = (rec: TranscriptRecord) => {
    if (running || !rec.sourcePath) return;
    addFiles([rec.sourcePath]);
    navigate("/transcribe");
  };

  const flashCopied = (key: string) => {
    setCopiedId(key);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
  };

  /** Copy what the session actually put into the target app: for a translated session the
   *  dictated text IS the injected join, not the original; a single language stays one hover
   *  away on each track. */
  const copyText = (rec: TranscriptRecord) => {
    const text = rec.translatedText || recordText(rec);
    void navigator.clipboard
      .writeText(stripControlChars(text))
      .then(() => flashCopied(rec.id))
      .catch((e) => console.error("history copy failed:", e));
  };

  const copyTrack = (rec: TranscriptRecord, lang: string, text: string) => {
    void navigator.clipboard
      .writeText(stripControlChars(text))
      .then(() => flashCopied(`${rec.id}:${lang}`))
      .catch((e) => console.error("history track copy failed:", e));
  };

  /** "Save audio…/Save video…": open the workbench straight onto the export
   *  panel with that Media choice (the panel holds the container and
   *  subtitle options — a row button cannot). */
  const openExport = (rec: TranscriptRecord, media: "audio" | "video") => {
    if (openHistoryRecord(rec)) navigate("/transcribe", { state: { openExport: { media } } });
  };

  const dropExportError = (id: string) =>
    setExportErrors((m) => {
      if (!m.has(id)) return m;
      const n = new Map(m);
      n.delete(id);
      return n;
    });

  const quickExport = async (rec: TranscriptRecord) => {
    // Only this row's own note: another row's failure stays until that row is retried.
    dropExportError(rec.id);
    const t = settings.transcribe ?? {};
    const format = (t.exportFormat ?? "srt") as ExportFormat;
    const ext = EXPORT_EXTENSIONS[format];
    // A link's sourceName is its title; its sourcePath is the URL the stem
    // reads the site from (and the date leads, like the viewer's export).
    // The in-session yt-dlp extractor names the site for hosts with no usable
    // label (an IP, a single-label host) — the viewer's export passes it too.
    const extractor = rec.kind === "url" ? useTranscribeRun.getState().urlMeta[rec.sourcePath]?.extractor : undefined;
    const stem = rec.kind === "url"
      ? exportStem(rec.title, rec.sourcePath, { createdAt: rec.createdAt, extractor })
      : exportStem(rec.title, rec.sourceName);
    let path: string | null;
    try {
      path = await pickExportPath(`${stem}.${ext}`, format.toUpperCase(), ext);
    } catch (e) {
      console.error("history export dialog failed:", e);
      setExportErrors((m) => new Map(m).set(rec.id, String(e)));
      return;
    }
    if (!path) return;
    // The dialog awaited: a retranslate chunk or edit may have landed meanwhile, so the
    // file is built from the record's latest copy (the stem stays the one the path used).
    const live = currentRecord(rec.id) ?? rec;
    try {
      // EVERY track the record has (not the viewer's visible pick — the export panel writes
      // that), in the viewer's order (a dragged order included), site tracks named from the
      // link. Inside the try: an on-disk record is unvalidated, and a throw here must land in
      // the row's export note rather than escape the fire-and-forget `void quickExport(rec)`.
      const result = withTrackSites(recordEditedResult(live), live.sourcePath, extractor);
      const all = transcriptTracks(result);
      const tg = displayToggles(t);
      const files = generateExports(result, exportOptionsFor({
        format,
        speakers: speakerOrder(live.result ?? { text: "" }),
        renames: live.renames ?? {},
        colorPicks: live.speakerColors ?? {},
        // The viewer's display toggles (legacy speakerColorMode migration included) — minus the
        // 1 s placeholder clocks of a plain-text source, which the viewer and Copy hide too. The
        // export panel deliberately keeps them on its warned switch (its Summary flags them);
        // this one-click export has no Summary to warn in.
        toggles: { ...tg, showTs: tg.showTs && !result.timingSynthesized },
        cues: cueOptionsOf(t),
        tracks: all.length > 1 ? trackOrder(result, all, readTrackPrefs(live.exportTracks).order) : [],
      }));
      const written: string[] = [];
      if (files.length === 1) {
        await saveTextFile(path, files[0].content);
        written.push(path);
      } else {
        // The picked path names the first file — never double-suffix its siblings.
        const { dir, stem: pickedStem } = derivePickedStem(path, files[0].name(""), ext);
        for (const f of files) {
          const dest = dir + f.name(pickedStem);
          await saveTextFile(dest, f.content);
          written.push(dest);
        }
      }
      if (revealAfterSaveOn(t)) void revealSaved(written);
    } catch (e) {
      console.error("history export failed:", e);
      setExportErrors((m) => new Map(m).set(rec.id, String(e)));
    }
  };

  const deleteButton = (rec: TranscriptRecord) => (
    <Button
      // The armed face by variant, not an appended colour: the ghost face's hover:text-text
      // out-specifies a plain text-rec, so "Delete?" read grey under the pointer.
      variant={armedDelete === rec.id ? "danger" : "ghost"}
      size="sm"
      title={armedDelete === rec.id ? "Click again to delete from disk" : "Delete"}
      onClick={() => {
        if (armedDelete === rec.id) {
          deleteRecord(rec.id);
          dropExportError(rec.id);
          setArmedDelete(null);
          if (expandedId === rec.id) setExpandedId(null);
        } else {
          setArmedDelete(rec.id);
        }
      }}
    >
      <Trash2 className="size-3.5" />
      {armedDelete === rec.id && "Delete?"}
    </Button>
  );

  const copyButton = (rec: TranscriptRecord, accent = false) => (
    <Button
      variant={accent ? "default" : "ghost"}
      size="sm"
      title="Copy the dictated text"
      onClick={() => copyText(rec)}
    >
      {copiedId === rec.id ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {accent && (copiedId === rec.id ? "Copied" : "Copy text")}
    </Button>
  );

  const dictMeta = (rec: TranscriptRecord) => {
    const parts = [
      timeOf(rec.createdAt),
      rec.result?.duration ? fmtDuration(rec.result.duration) : "",
      rec.wordCount ? plural(rec.wordCount, "word") : "",
      // A set language that sanitizes to blank is still sent, so it reads "??" as RouteBadge does.
      typeof rec.language === "string" && rec.language && rec.language !== "auto"
        ? langText(rec.language, 12).trim() || "??"
        : "",
      rec.insertMethod === "clipboard"
        ? "clipboard only"
        : rec.insertMethod === "none"
          ? "not inserted"
          : "",
    ].filter(Boolean);
    return parts.join(" · ");
  };

  // Gated on what the pill would SHOW, read as the chip reads an authored tag: `profileTag` is
  // stored after a plain trim, so it can keep format-only characters and U+2800 padding — a
  // raw-truthy check would draw an empty pill or cut a padded tag's visible part.
  const tagBadge = (rec: TranscriptRecord) => {
    const tag = safeDisplayText(authoredChipTag(rec.profileTag), 16).trim();
    return tag ? <Badge tone="accent">{tag}</Badge> : null;
  };

  const glyph = (rec: TranscriptRecord) => {
    if (isDictation(rec)) {
      return (
        <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" title="Dictation">
          <Mic className="size-3.5" />
        </span>
      );
    }
    const ok = rec.status === "done";
    const isUrl = rec.kind === "url";
    const isText = rec.kind === "text";
    const kindLabel = isUrl ? "Link transcription" : isText ? "Text translation" : "File transcription";
    return (
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-lg",
          ok ? "bg-ok/15 text-ok" : "bg-rec/15 text-rec",
        )}
        title={ok ? kindLabel : `${kindLabel} · failed`}
      >
        {!ok ? <X className="size-3.5" /> : isUrl ? <Link2 className="size-3.5" /> : isText ? <FileText className="size-3.5" /> : <FileAudio className="size-3.5" />}
      </span>
    );
  };

  const dictationExpanded = (rec: TranscriptRecord) => {
    // Names by the shared display-name rule the other screens use; a record without a (string)
    // profile name, or whose backend is gone, shows no label.
    const profileShown = typeof rec.profileName === "string" ? profileDisplayName(rec.profileName, 40) : "";
    const backendShown = backendLabelById(backends, rec.backendId) ?? "";
    const failureShown = safeDisplayText(rec.translationFailure ?? "", 24).trim();
    const shownModel = shortModelName(rec.model, 40);
    const tracks = recordTracks(rec);
    return (
      <div key={rec.id} className="my-2 rounded-xl border border-accent/25 bg-accent-soft/30 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {glyph(rec)}
          <span className="text-[13px] font-medium text-text">{safeDisplayText(appLabel(rec), 60)}</span>
          {tagBadge(rec)}
          <span className="flex-1 font-mono text-[11px] text-faint">{dictMeta(rec)}</span>
          {copyButton(rec, true)}
          {deleteButton(rec)}
          <Button
            variant="ghost"
            size="sm"
            title="Collapse"
            onClick={() => setExpandedId(null)}
          >
            <ChevronUp className="size-3.5" />
          </Button>
        </div>
        {rec.sourcePath ? (
          /* Keyed by path: a path re-pointed by the audio-layout migration or
             heal (History reloads on transcripts://swept) is a new recording,
             so the player starts clean and an earlier failed read cannot hide
             a playable file. */
          <RecordingPlayer key={rec.sourcePath} path={rec.sourcePath} />
        ) : (
          <div className="mt-3 text-[12px] text-faint">
            No recording linked — “Keep audio recordings” was off for this session.
          </div>
        )}
        {tracks ? (
          /* One track per language, the original as a track of its own (not the
             injected blob, which may already begin with the original). Hairline
             dividers rather than blank lines: a transcript has its own line
             breaks, so a blank line does not read as a language boundary. */
          <div className="mt-3 grid max-h-56 grid-cols-[minmax(2.5rem,max-content)_minmax(0,1fr)] gap-x-2 overflow-y-auto">
            {tracks.map(({ lang, text, orig }, i) => {
              // A format-only code (file-borne, or a synced translateTo entry) displays as nothing
              // once langText strips it (joiners too) — "??" keeps the tag and the copy tooltip readable.
              // The raw lang stays the key, the copy target and the "copied" id.
              const tag = langText(lang, 12).trim() || "??";
              return (
                <div
                  // A profile may translate INTO its own source language (nothing excludes it),
                  // which would give the original track and a target the same code.
                  key={`${i}:${lang}`}
                  className={cn(
                    "col-span-full grid grid-cols-subgrid py-2", // one tag column for every track, so texts align
                    i > 0 && "border-t border-line",
                  )}
                >
                  <div className="pt-[3px]">
                    <LangTag code={tag} orig={orig} />
                  </div>
                  <div className="group/track relative">
                    <div
                      className={cn(
                        "select-text whitespace-pre-wrap text-[13px] leading-relaxed",
                        orig ? "text-dim" : "text-text/90",
                      )}
                    >
                      {stripControlChars(text)}
                    </div>
                    <button
                      type="button"
                      onClick={() => copyTrack(rec, lang, text)}
                      className="absolute right-0 top-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-faint opacity-0 transition hover:text-text focus-visible:opacity-100 group-hover/track:opacity-100"
                      title={`Copy the ${tag.toUpperCase()} track`}
                    >
                      {copiedId === `${rec.id}:${lang}` ? "copied" : "copy"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : rec.translatedText ? (
          /* A record written before per-language tracks existed: the blob is an
             unsplittable join, so it renders as one block, and result.text is not
             repeated beneath it (the blob may already contain the original). */
          <div className="mt-3 max-h-56 overflow-y-auto">
            <span
              className="font-mono text-[10px] uppercase tracking-wider"
              // The same accent-mixed tone LangTag gives an MT track with no speaker
              // colour, so this pre-track blob reads as one of them (teal is the STAGE).
              style={{ color: "color-mix(in srgb, var(--c-accent) 65%, var(--c-faint))" }}
            >
              {/* No "injected / not injected" claim: `translationInjected` is derived
                  from the same value as `translatedText` (streaming.ts), so it carries
                  nothing about whether the text reached the field. */}
              {targetsText(rec.translationTarget, 24) || "translated"}
            </span>
            <div className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-text/90">
              {stripControlChars(rec.translatedText)}
            </div>
          </div>
        ) : (
          <>
            {/* Translation was configured but produced nothing: the body below IS the
                original, and so was whatever reached the field — the tail names how (nothing
                when never delivered; the meta line says "not inserted"). Without this note the
                record silently presents the original as the intended output. */}
            {rec.translationAttempted && (
              <div className="mt-3 font-mono text-[11px] text-warn">
                translation to {targetsText(rec.translationTarget, 40) || "the target language"} failed
                {failureShown ? ` (${failureShown})` : ""}
                {rec.insertMethod === "typed"
                  ? " — original inserted"
                  : rec.insertMethod === "clipboard"
                    ? " — original copied to the clipboard"
                    : ""}
              </div>
            )}
            <div className="mt-3 max-h-56 select-text overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-text/90">
              {stripControlChars(recordText(rec))}
            </div>
          </>
        )}
        <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
          {profileShown && (
            <span className="font-mono text-[11px] text-faint">
              profile <span className="text-dim">{profileShown}{rec.activation ? ` · ${rec.activation}` : ""}</span>
            </span>
          )}
          {/* The picker's label (an up-to-80-codepoint name plus a host suffix) is bounded
              here, whole on hover. */}
          {backendShown && (
            <span className="font-mono text-[11px] text-faint">
              backend <span className="inline-block max-w-[20rem] truncate align-bottom text-dim" title={backendShown}>{backendShown}</span>
            </span>
          )}
          {shownModel && (
            <span className="font-mono text-[11px] text-faint">
              model <span className="text-dim">{shownModel}</span>
            </span>
          )}
          {typeof rec.insertMethod === "string" && rec.insertMethod && rec.insertMethod !== "none" && (
            <span className="font-mono text-[11px] text-faint">
              inserted <span className="text-dim">{rec.insertMethod}</span>
            </span>
          )}
          {rec.sourcePath && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={running}
              title={
                running
                  ? "Wait for the current run to finish"
                  : "Transcribe the recording with word timestamps — karaoke, corrections, exports"
              }
              onClick={() => openRecordingInWorkbench(rec)}
            >
              <ExternalLink className="size-3.5" />
              Open in workbench
            </Button>
          )}
        </div>
      </div>
    );
  };

  const dictationRow = (rec: TranscriptRecord, last: boolean) => (
    <div
      key={rec.id}
      role="button"
      tabIndex={0}
      onClick={() => setExpandedId(rec.id)}
      onKeyDown={(e) => {
        // Keys aimed at the nested Copy/Delete buttons must reach them: their
        // activation IS this keydown's default action, so cancelling it here
        // would swallow the action and expand the row instead.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setExpandedId(rec.id);
        }
      }}
      className={cn(
        "ring-signal flex w-full cursor-pointer items-center gap-3 rounded-md py-3 text-left",
        !last && "border-b border-line",
      )}
    >
      {glyph(rec)}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="truncate text-[13px] font-medium text-text">
            {safeDisplayText(appLabel(rec), 60)}
          </span>
          {tagBadge(rec)}
          {/* The session's translation targets: without it a translated session and a
              plain one look identical in the list. */}
          {rec.translationTargets?.length ? (
            <RouteBadge source={rec.language ?? ""} targets={rec.translationTargets} />
          ) : null}
          <span className="shrink-0 font-mono text-[11px] text-faint">{dictMeta(rec)}</span>
        </div>
        <div className="truncate text-[12px] text-faint">
          {stripControlChars(recordText(rec, 200), 160)}
        </div>
      </div>
      {/* Action clicks must not also expand the row (the whole row is a button). */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {copyButton(rec)}
        {deleteButton(rec)}
      </span>
    </div>
  );

  const fileRow = (rec: TranscriptRecord, last: boolean) => {
    const ok = rec.status === "done";
    const speakers = ok ? speakerOrder(rec.result ?? { text: "" }).length : 0;
    const edited =
      !!Object.keys(rec.edits ?? {}).length || !!Object.keys(rec.speakerEdits ?? {}).length;
    const shownModel = shortModelName(rec.model, 40);
    // Gate the meta parts on their sanitized text, not the raw value: a code of only
    // format characters would otherwise leave a dangling " · " (or an empty "+" join).
    const langShown = langText(rec.language ?? "", 12).trim();
    const targetsShown = langTexts(rec.result?.translation?.targets ?? []);
    const snippet = ok
      ? stripControlChars(recordText(rec, 200), 160)
      : stripControlChars(rec.error ?? "failed", 160);
    return (
      <div key={rec.id} className={cn("flex items-center gap-3 py-3", !last && "border-b border-line")}>
        {glyph(rec)}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2.5">
            <span className="truncate text-[13px] font-medium text-text">
              {safeDisplayText(rec.sourceName, 120)}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-faint">
              {timeOf(rec.createdAt)}
              {rec.kind === "url" && rec.sourcePath ? ` · ${safeDisplayText(urlHost(rec.sourcePath), 60)}` : ""}
              {rec.result?.duration ? ` · ${fmtDuration(rec.result.duration)}` : ""}
              {langShown ? ` · ${langShown}` : ""}
              {speakers > 1 ? ` · ${speakers} speakers` : ""}
              {targetsShown.length ? ` · ${targetsShown.join("+")}` : ""}
              {shownModel ? ` · ${shownModel}` : ""}
            </span>
            {edited && <span className="shrink-0 font-mono text-[11px] text-accent">· edited</span>}
          </div>
          <div className={cn("truncate text-[12px]", ok ? "text-faint" : "text-rec")}>{snippet}</div>
        </div>
        {ok && (
          <Button
            variant="ghost"
            size="sm"
            title="Export with your current format and display settings"
            onClick={() => void quickExport(rec)}
          >
            <Download className="size-3.5" />
          </Button>
        )}
        {ok && rec.kind === "url" && (rec.mediaPath || linkServerAudioLive(rec.result, Date.now() / 1000)) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            title={running ? "Wait for the current run to finish" : "Save the audio…"}
            onClick={() => openExport(rec, "audio")}
          >
            <FileAudio className="size-3.5" />
          </Button>
        )}
        {ok && (rec.kind === "url" || (rec.kind !== "text" && isVideoSourcePath(rec.sourcePath))) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={running}
            title={running ? "Wait for the current run to finish" : "Save the video (with subtitles)…"}
            onClick={() => openExport(rec, "video")}
          >
            <Film className="size-3.5" />
          </Button>
        )}
        {exportErrors.has(rec.id) && (
          <span className="text-[11px] text-warn" role="alert">
            Export failed: {safeDisplayText(exportErrors.get(rec.id) ?? "", 120)}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          title={
            running
              ? "Wait for the current run to finish"
              : rec.kind === "url"
                ? "Transcribe this link again with your current settings"
                : rec.kind === "text"
                  ? "Translate this file again with your current settings"
                  : "Transcribe this file again with your current settings"
          }
          onClick={() => retry(rec)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
        {deleteButton(rec)}
        {ok && (
          <Button
            variant="default"
            size="sm"
            disabled={running}
            title={running ? "Wait for the current run to finish" : "Open in the workbench"}
            onClick={() => open(rec)}
          >
            Open
          </Button>
        )}
      </div>
    );
  };

  const segLabel =
    segment === "file" ? "files"
      : segment === "url" ? "links"
        : segment === "text" ? "text translations"
          : "dictations";

  return (
    <div ref={rootRef} className="page page-prose">
      <PageHeader eyebrow={screenEyebrow("history")} title={screenTitle("history")} icon={HistoryIcon}>
        Everything you've dictated, transcribed, translated, or diarized.
        <br />
        Only stored locally on this machine.
      </PageHeader>

      <div className="page-content flex items-center gap-3">
        <Segmented
          value={segment}
          onChange={(v) => {
            setSegment(v);
            if (v !== "dictation") setAppFilter(null);
          }}
          options={[
            { value: "all", label: `All · ${fmtFull(searched.length)}` },
            { value: "file", label: `Files · ${fmtFull(fileMatches.length)}` },
            { value: "url", label: `Links · ${fmtFull(linkMatches.length)}` },
            { value: "text", label: `Text · ${fmtFull(textMatches.length)}` },
            { value: "dictation", label: `Dictations · ${fmtFull(dictMatches.length)}` },
          ]}
        />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search names, apps and text…"
            aria-label="Search history"
            className="pl-10"
          />
        </div>
        <button
          type="button"
          onClick={() => navigate(`/settings?tab=${encodeURIComponent("Recording & history")}`)}
          className="ring-signal shrink-0 rounded-md font-mono text-[11px] text-faint hover:text-text"
          title="Retention and dictation-history settings"
        >
          retention · Settings
        </button>
      </div>

      {segment === "dictation" && (apps.length > 1 || appFilter) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-faint">dictated into</span>
          {apps.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={appFilter === a.id}
              onClick={() => setAppFilter((f) => (f === a.id ? null : a.id))}
              className={cn(
                "ring-signal rounded-pill border px-2.5 py-0.5 text-[11.5px] transition-colors",
                appFilter === a.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line text-dim hover:text-text",
              )}
            >
              {safeDisplayText(a.label, 30)} · {fmtFull(a.n)}
            </button>
          ))}
          {appFilter && (
            <button
              type="button"
              onClick={() => setAppFilter(null)}
              className="ring-signal rounded-md text-[11.5px] text-faint hover:text-text"
            >
              clear
            </button>
          )}
        </div>
      )}

      {segment === "dictation" && dictationOff && (
        <Card className="mt-4 flex items-center gap-3 px-5 py-3.5">
          <MicOff className="size-4 shrink-0 text-faint" />
          <span className="flex-1 text-[12.5px] text-dim">
            Dictation history is off — sessions aren’t being saved. File transcriptions are still kept.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => patchTranscribe({ keepDictationHistory: true })}
          >
            Turn on
          </Button>
        </Card>
      )}

      {hiddenMatches > 0 && visible.length > 0 && (
        <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-accent/25 bg-accent-soft/40 px-4 py-2.5 text-[12.5px] text-dim">
          <Search className="size-3.5 shrink-0 text-accent" />
          {/* The app chip counts too: the hidden matches may be dictations into other apps. */}
          <span className="flex-1">
            {appFilter && segment === "dictation" ? (
              <>
                {plural(visible.length, "match", "matches")} in dictations for this app —{" "}
                {fmtFull(hiddenMatches)} more in other apps or types
              </>
            ) : (
              <>
                {plural(visible.length, "match", "matches")} in {segLabel} —{" "}
                {fmtFull(hiddenMatches)} more outside {segLabel}
              </>
            )}
          </span>
          <Button variant="ghost" size="sm" onClick={() => { setSegment("all"); setAppFilter(null); }}>
            Show all
          </Button>
        </div>
      )}

      {loaded && loadFailed && (
        <Notice className="mt-4">
          <div>
            Couldn’t read the saved history — this list may not match what is saved on disk
            (entries may be missing or already removed).
          </div>
          <div className="mt-2 flex items-center gap-2">
            {/* Non-forced, so a retry before any successful listing keeps this session's
                records (their saves may not be on disk). loadHistory never rejects. */}
            <Button
              variant="ghost"
              size="sm"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void loadHistory().finally(() => setRetrying(false));
              }}
            >
              <RotateCcw className="size-3.5" />
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </Notice>
      )}
      {loaded && !loadFailed && !records.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          Nothing here yet — transcribe a file or dictate something and it will be kept automatically.
        </Card>
      )}
      {loaded && records.length > 0 && !visible.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          {/* The app filter only narrows the Dictations segment — name it in both branches, or a
              search hidden by it reads "No dictations match" beside a segment count of 1. */}
          {query.trim()
            ? `No ${segment === "all" ? "entries" : segLabel}${appFilter && segment === "dictation" ? " for this app" : ""} match "${safeDisplayText(query, 80)}".`
            : `No ${segment === "all" ? "entries" : segLabel}${appFilter && segment === "dictation" ? " for this app" : ""} yet.`}
          <div className="mt-3 flex items-center justify-center gap-2">
            {hiddenMatches > 0 && (
              <Button variant="default" size="sm" onClick={() => { setSegment("all"); setAppFilter(null); }}>
                Show all types · {fmtFull(searched.length)}
              </Button>
            )}
            {query.trim() && (
              <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            )}
            {appFilter && (
              <Button variant="ghost" size="sm" onClick={() => setAppFilter(null)}>
                Clear app filter
              </Button>
            )}
          </div>
        </Card>
      )}

      {buckets.map((bucket) => (
        <div key={bucket.label}>
          <div className="mt-6 font-mono text-[10.5px] uppercase tracking-label text-faint">
            {bucket.label}
          </div>
          <Card className="mt-2 px-5 py-1">
            {bucket.items.map((rec, i) => {
              const last = i === bucket.items.length - 1;
              if (isDictation(rec)) {
                return expandedId === rec.id ? dictationExpanded(rec) : dictationRow(rec, last);
              }
              return fileRow(rec, last);
            })}
          </Card>
        </div>
      ))}
    </div>
  );
}
