// History: one day-bucketed timeline for BOTH record kinds — file
// transcriptions and dictation sessions — filtered by an All/Files/Links/Dictations
// segment (the call-log pattern) plus "dictated into" app chips. File rows
// open the full workbench; dictation rows expand INLINE: full text, the saved
// recording playable in place, Copy as the main action, and "Open in
// workbench" to re-run the recording through batch transcription (word
// timestamps → karaoke). Search is global; when the active segment hides
// matches, a banner names them (NN/g scoped-search guidance).

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check, ChevronUp, Copy, Download, ExternalLink, FileAudio, FileText, Link2, Mic, MicOff,
  Pause, Play, RotateCcw, Search, Trash2, X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  LangTag,
  PageHeader,
  RouteBadge,
  Segmented,
  TextInput,
} from "@/components/ui";
import { useApp } from "@/lib/store";
import { fmtDuration } from "@/lib/format";
import { pickExportPath, readMediaFile, saveTextFile } from "@/lib/api";
import {
  deleteRecord, loadHistory, recordEditedResult, recordText,
  useTranscriptHistory, type TranscriptRecord,
} from "@/lib/transcriptHistory";
import { addFiles, openHistoryRecord, useTranscribeRun } from "@/lib/transcribeRun";
import {
  DEFAULT_SPEAKER_COLORS, EXPORT_EXTENSIONS, generateExports, speakerOrder,
  type ExportFormat,
} from "@/lib/transcriptExport";
import { stripControlChars, safeDisplayText } from "@/lib/sanitize";
import { urlHost } from "@/lib/urlSource";
import { cn } from "@/lib/cn";

/** "Today" / "Yesterday" / a local date — the bucket a record sorts under. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const isDictation = (r: TranscriptRecord) => r.kind === "dictation";

/** The record's language tracks, original first, or null when it has none.
 *
 *  Returns null for records written before per-language tracks existed: their
 *  `translatedText` is a blank-line join and a transcript contains its own
 *  line breaks, so splitting it back apart would mislabel text rather than
 *  recover it. Those records render as one untitled block instead — the most
 *  that can honestly be said about them. */
export function tracksOf(
  rec: TranscriptRecord,
): { lang: string; text: string; orig?: boolean }[] | null {
  const tr = rec.translations;
  if (!tr || typeof tr !== "object") return null;
  const langs = (rec.translationTargets ?? Object.keys(tr)).filter(
    (l) => typeof l === "string" && tr[l]?.trim(),
  );
  if (!langs.length) return null;
  const original = recordText(rec).trim();
  // The original is a track like any other, dimmed and carrying its own code.
  // Rendering it as a separate labelled section BELOW the blob is what showed
  // it twice, because the blob already began with it.
  const head =
    original && rec.includeOriginal
      ? [{ lang: rec.language && rec.language !== "auto" ? rec.language : "orig", text: original, orig: true }]
      : [];
  return [...head, ...langs.map((lang) => ({ lang, text: tr[lang] }))];
}

/** Human app label from a dictation record — the stored window title, else the
 *  app id's last dot-segment, capitalized ("org.mozilla.thunderbird" → "Thunderbird"). */
function appLabel(r: TranscriptRecord): string {
  if (r.sourceName && r.sourceName !== "Dictation") return r.sourceName;
  const seg = r.appId?.split(".").pop()?.trim();
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Dictation";
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

/** Inline player for a dictation's saved .wav. Loads via readMediaFile → blob
 *  URL (the asset protocol can't feed WebKitGTK's media stack; blob: is in the
 *  CSP). A missing/expired file degrades to a one-line note, not an error. */
function RecordingPlayer({ path }: { path: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [len, setLen] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    let stale = false;
    let url: string | null = null;
    readMediaFile(path)
      .then((buf) => {
        if (stale) return;
        url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        setSrc(url);
      })
      .catch(() => {
        if (!stale) setGone(true);
      });
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (gone) {
    return (
      <div className="mt-3 text-[12px] text-faint">
        Audio unavailable — removed by retention, or recordings were off.
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
        ref={audioRef}
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
      <span className="font-mono text-[11px] text-dim">{fmtDuration(cur)}</span>
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
          const a = audioRef.current;
          if (!a) return;
          if (e.key === "ArrowLeft") a.currentTime = Math.max(0, a.currentTime - 5);
          if (e.key === "ArrowRight") a.currentTime = Math.min(len, a.currentTime + 5);
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
      <span className="font-mono text-[11px] text-faint">{fmtDuration(len)}</span>
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
  const running = useTranscribeRun((s) => s.running);
  const settings = useApp((s) => s.settings);
  const backends = useApp((s) => s.backends);
  const updateSettings = useApp((s) => s.updateSettings);
  const [query, setQuery] = useState(viewMemory.query);
  const [segment, setSegment] = useState<Segment>(viewMemory.segment);
  const [appFilter, setAppFilter] = useState<string | null>(viewMemory.appFilter);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Two-step delete: first click arms the row, second click deletes.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  // The view survives navigation: filters mirror into the module store as
  // they change…
  useEffect(() => {
    viewMemory.query = query;
    viewMemory.segment = segment;
    viewMemory.appFilter = appFilter;
  }, [query, segment, appFilter]);
  // …and the scroll position of the app's <main> is restored on mount and
  // captured on unmount (the container itself persists across routes, so
  // without this the list opened wherever the previous page left it).
  useEffect(() => {
    const main = rootRef.current?.closest("main");
    if (main) main.scrollTop = viewMemory.scrollTop;
    return () => {
      if (main) viewMemory.scrollTop = main.scrollTop;
    };
  }, []);

  // Search first (global — both kinds, names AND text), THEN the segment/app
  // facets, so hidden matches can be counted and surfaced.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter(
      (r) =>
        r.sourceName.toLowerCase().includes(q) ||
        (r.appId ?? "").toLowerCase().includes(q) ||
        recordText(r).toLowerCase().includes(q),
    );
  }, [records, query]);

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
      const key = r.appId ?? appLabel(r);
      const cur = counts.get(key);
      if (cur) cur.n++;
      else counts.set(key, { label: appLabel(r), n: 1 });
    }
    return [...counts.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);
  }, [dictMatches]);

  const visible = useMemo(() => {
    let out =
      segment === "file" ? fileMatches
        : segment === "url" ? linkMatches
          : segment === "text" ? textMatches
            : segment === "dictation" ? dictMatches
              : searched;
    if (appFilter && segment === "dictation") {
      out = out.filter((r) => (r.appId ?? appLabel(r)) === appFilter);
    }
    return out;
  }, [searched, fileMatches, linkMatches, textMatches, dictMatches, segment, appFilter]);

  // Matches the active segment hides (never silently — NN/g scoped search).
  const hiddenMatches =
    query.trim() && segment !== "all"
      ? searched.length -
        (segment === "file" ? fileMatches.length
          : segment === "url" ? linkMatches.length
          : segment === "text" ? textMatches.length
            : dictMatches.length)
      : 0;

  const buckets = useMemo(() => {
    const out: { label: string; items: TranscriptRecord[] }[] = [];
    for (const rec of visible) {
      const label = dayBucket(rec.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(rec);
      else out.push({ label, items: [rec] });
    }
    return out;
  }, [visible]);

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

  /** Copy what the session actually put into the target app.
   *
   *  This used to copy recordText(rec) — the ORIGINAL transcript — under a
   *  button labelled "Copy the dictated text", even when what was dictated
   *  into the field was all three languages. For a translated session the
   *  dictated text IS the injected join, so that is what the clipboard gets;
   *  a single language stays one hover away on each track. */
  const copyText = (rec: TranscriptRecord) => {
    const text = rec.translatedText ?? recordText(rec);
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

  const quickExport = async (rec: TranscriptRecord) => {
    const t = settings.transcribe ?? {};
    const format = (t.exportFormat ?? "srt") as ExportFormat;
    const ext = EXPORT_EXTENSIONS[format];
    const stem =
      rec.kind === "url"
        ? rec.sourceName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "transcript"
        : rec.sourceName.replace(/\.[^.]+$/, "");
    let path: string | null;
    try {
      path = await pickExportPath(`${stem}.${ext}`, format.toUpperCase(), ext);
    } catch (e) {
      console.error("history export dialog failed:", e);
      return;
    }
    if (!path) return;
    const order = speakerOrder(rec.result ?? { text: "" });
    // Every track the record carries rides the quick export ("orig" + targets).
    const recLangs = Array.from(
      new Set(
        (rec.result?.segments ?? []).flatMap((seg) => Object.keys(seg.translations ?? {})),
      ),
    );
    try {
      const files = generateExports(recordEditedResult(rec), {
        format,
        renames: rec.renames ?? {},
        speakerColors: order.length && (t.colorizeSpeakers ?? true) ? "line" : "off",
        speakerNames: t.showSpeakerNames ?? true,
        timestamps: t.showTimestamps ?? false,
        colors: Object.fromEntries(
          Object.entries(rec.speakerColors ?? {}).map(([l, i]) => [
            l,
            DEFAULT_SPEAKER_COLORS[i % DEFAULT_SPEAKER_COLORS.length],
          ]),
        ),
        wordTimestamps: t.wordTimestamps ?? false,
        ...(recLangs.length ? { tracks: ["orig", ...recLangs] } : {}),
      });
      if (files.length === 1) {
        await saveTextFile(path, files[0].content);
      } else {
        const sep = path.includes("\\") ? "\\" : "/";
        const dir = path.slice(0, path.lastIndexOf(sep) + 1);
        // Strip the seeded first-file suffix from what the user confirmed
        // (mirrors the viewer's doExport — never double-suffix siblings).
        const firstSuffix = files[0].name("");
        const base = path.slice(dir.length);
        const pickedStem = base.endsWith(firstSuffix)
          ? base.slice(0, -firstSuffix.length)
          : base.replace(/\.lrc$/i, "");
        for (const f of files) await saveTextFile(dir + f.name(pickedStem), f.content);
      }
    } catch (e) {
      console.error("history export failed:", e);
    }
  };

  const deleteButton = (rec: TranscriptRecord) => (
    <Button
      variant="ghost"
      size="sm"
      className={cn(armedDelete === rec.id && "text-rec")}
      title={armedDelete === rec.id ? "Click again to delete from disk" : "Delete"}
      onClick={() => {
        if (armedDelete === rec.id) {
          deleteRecord(rec.id);
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
      rec.wordCount ? `${rec.wordCount} words` : "",
      rec.language && rec.language !== "auto" ? safeDisplayText(rec.language, 12) : "",
      rec.insertMethod === "clipboard"
        ? "clipboard only"
        : rec.insertMethod === "none"
          ? "not inserted"
          : "",
    ].filter(Boolean);
    return parts.join(" · ");
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
    const backendName = backends.find((b) => b.id === rec.backendId)?.name;
    return (
      <div key={rec.id} className="my-2 rounded-xl border border-accent/25 bg-accent-soft/30 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {glyph(rec)}
          <span className="text-[13px] font-medium text-text">{safeDisplayText(appLabel(rec), 60)}</span>
          {rec.profileTag && <Badge tone="accent">{safeDisplayText(rec.profileTag, 20)}</Badge>}
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
          <RecordingPlayer path={rec.sourcePath} />
        ) : (
          <div className="mt-3 text-[12px] text-faint">
            No recording linked — “Keep audio recordings” was off for this session.
          </div>
        )}
        {tracksOf(rec) ? (
          /* One track per language, the original included as a track of its
             own. Previously this rendered the INJECTED blob (which, with
             "include original" on, already begins with the original) and then
             rendered result.text again beneath it under an "original" label —
             so the source language appeared twice, under a heading naming only
             the targets. Hairline dividers rather than blank lines, because a
             transcript contains its own line breaks and a blank line does not
             read as a language boundary. */
          <div className="mt-3 max-h-56 overflow-y-auto">
            {tracksOf(rec)!.map(({ lang, text, orig }, i) => (
              <div
                key={lang}
                className={cn(
                  "grid grid-cols-[2.5rem_1fr] gap-2 py-2",
                  i > 0 && "border-t border-line",
                )}
              >
                <div className="pt-[3px]">
                  <LangTag code={lang} orig={orig} />
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
                    title={`Copy the ${lang.toUpperCase()} track`}
                  >
                    {copiedId === `${rec.id}:${lang}` ? "copied" : "copy"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : rec.translatedText ? (
          /* A record written before per-language tracks existed. The blob is
             an unsplittable join, so the honest rendering is one untitled
             block — but result.text is NOT repeated beneath it any more, which
             was the duplicate the user saw. */
          <div className="mt-3 max-h-56 overflow-y-auto">
            <span className="font-mono text-[10px] uppercase tracking-wider text-translate">
              {/* Never hard-code "injected": the record already carries whether the
                  translation actually reached the field (stop-timing can produce a
                  translation that the session then failed to insert), and a label that
                  can lie about where the user's words went is worse than none. */}
              {safeDisplayText(rec.translationTarget ?? "translated", 24)}
              {rec.translationInjected ? " · injected" : " · not injected"}
            </span>
            <div className="select-text whitespace-pre-wrap text-[13px] leading-relaxed text-text/90">
              {stripControlChars(rec.translatedText)}
            </div>
          </div>
        ) : (
          <>
            {/* Translation was configured but produced nothing: the body below IS the
                original, and it is the text that was inserted. Saying so — with the cause —
                is the difference between "this session had no translation" and "the
                translation you asked for didn't happen"; without it the record silently
                presents the original as the intended output. */}
            {rec.translationAttempted && (
              <div className="mt-3 font-mono text-[11px] text-warn">
                translation to {safeDisplayText(rec.translationTarget ?? "the target language", 40)} failed
                {rec.translationFailure ? ` (${safeDisplayText(rec.translationFailure, 24)})` : ""} — original
                inserted
              </div>
            )}
            <div className="mt-3 max-h-56 select-text overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-text/90">
              {stripControlChars(recordText(rec))}
            </div>
          </>
        )}
        <div className="mt-3 flex items-center gap-4 border-t border-line pt-3">
          {rec.profileName && (
            <span className="font-mono text-[11px] text-faint">
              profile <span className="text-dim">{safeDisplayText(rec.profileName, 40)}{rec.activation ? ` · ${rec.activation}` : ""}</span>
            </span>
          )}
          {backendName && (
            <span className="font-mono text-[11px] text-faint">
              backend <span className="text-dim">{safeDisplayText(backendName, 40)}</span>
            </span>
          )}
          {rec.model && (
            <span className="font-mono text-[11px] text-faint">
              model <span className="text-dim">{safeDisplayText(rec.model.split("/").pop() ?? rec.model, 40)}</span>
            </span>
          )}
          {rec.insertMethod && (
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
          {rec.profileTag && <Badge tone="accent">{safeDisplayText(rec.profileTag, 20)}</Badge>}
          {/* Which languages this dictation produced. Without it a translated
              session and a plain one look identical in the list, and the only
              way to find out was to expand every row. */}
          {rec.translationTargets?.length ? (
            <RouteBadge source={rec.language ?? ""} targets={rec.translationTargets} />
          ) : null}
          <span className="shrink-0 font-mono text-[11px] text-faint">{dictMeta(rec)}</span>
        </div>
        <div className="truncate text-[12px] text-faint">
          {stripControlChars(recordText(rec)).slice(0, 160)}
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
    const snippet = ok
      ? stripControlChars(recordText(rec)).slice(0, 160)
      : stripControlChars(rec.error ?? "failed").slice(0, 160);
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
              {rec.language ? ` · ${safeDisplayText(rec.language, 12)}` : ""}
              {speakers > 1 ? ` · ${speakers} speakers` : ""}
              {rec.result?.translation?.targets?.length
                ? ` · ${rec.result.translation.targets.map((t) => safeDisplayText(t, 8)).join("+")}`
                : ""}
              {rec.model ? ` · ${safeDisplayText(rec.model.split("/").pop() ?? rec.model, 40)}` : ""}
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
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          title={
            running
              ? "Wait for the current run to finish"
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
    <div ref={rootRef} className="mx-auto max-w-[820px] px-10 py-12">
      <PageHeader eyebrow="transcribe" title="History">
        Everything you transcribed or dictated — stored only on this machine.
      </PageHeader>

      <div className="mt-8 flex items-center gap-3">
        <Segmented
          value={segment}
          onChange={(v) => {
            setSegment(v);
            if (v !== "dictation") setAppFilter(null);
          }}
          options={[
            { value: "all", label: `All · ${searched.length}` },
            { value: "file", label: `Files · ${fileMatches.length}` },
            { value: "url", label: `Links · ${linkMatches.length}` },
            { value: "text", label: `Text · ${textMatches.length}` },
            { value: "dictation", label: `Dictations · ${dictMatches.length}` },
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

      {segment === "dictation" && apps.length > 1 && (
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
              {safeDisplayText(a.label, 30)} · {a.n}
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
            onClick={() =>
              updateSettings({
                transcribe: { ...settings.transcribe, keepDictationHistory: true },
              })
            }
          >
            Turn on
          </Button>
        </Card>
      )}

      {hiddenMatches > 0 && (
        <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-accent/25 bg-accent-soft/40 px-4 py-2.5 text-[12.5px] text-dim">
          <Search className="size-3.5 shrink-0 text-accent" />
          <span className="flex-1">
            {visible.length} match{visible.length === 1 ? "" : "es"} in {segLabel} —{" "}
            {hiddenMatches} more outside {segLabel}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSegment("all")}>
            Show all
          </Button>
        </div>
      )}

      {loaded && !records.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          Nothing here yet — transcribe a file or dictate something and it will be kept automatically.
        </Card>
      )}
      {loaded && records.length > 0 && !visible.length && (
        <Card className="mt-6 p-8 text-center text-[13px] text-dim">
          {query.trim()
            ? `No ${segment === "all" ? "entries" : segLabel} match "${safeDisplayText(query, 80)}".`
            : `No ${segment === "all" ? "entries" : segLabel}${appFilter ? " for this app" : ""} yet.`}
          <div className="mt-3 flex items-center justify-center gap-2">
            {query.trim() && segment !== "all" && searched.length > visible.length && (
              <Button variant="default" size="sm" onClick={() => setSegment("all")}>
                Show all types · {searched.length}
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
