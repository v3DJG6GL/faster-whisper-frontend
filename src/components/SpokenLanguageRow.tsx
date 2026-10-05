// The link card's "Spoken language" row (D86): the spoken picker, where the value comes from
// (from YouTube / detected in 3 of 3 pieces / detected · also English / edited), the sampled
// pieces once the check is done, and two fixed icon buttons — ⟳ check the audio with Whisper,
// ↺ back to what the link speaks. The check runs on its own after the preview when the site
// names no language; it downloads the audio, which the run then reuses.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { SpokenLanguagePicker } from "@/components/LanguagePicker";
import { cancelTextTranslation, urlLanguageCheck } from "@/lib/api";
import { cn } from "@/lib/cn";
import { languageLabel, namedLanguage } from "@/lib/languages";
import { safeDisplayText } from "@/lib/sanitize";
import { linkSpoken, spokenPill, type LinkLanguageCheck, type LinkSpoken } from "@/lib/siteSubtitles";
import type { UrlPreview } from "@/lib/urlSource";

export interface LinkLanguage {
  sp: LinkSpoken;
  check: LinkLanguageCheck;
  enabled: boolean;
  pick: (v: string) => void;
  reset: () => void;
  recheck: () => void;
  /** The audio the finished check downloaded, for the run to reuse. */
  prefetchMediaId: string | null;
}

/** One link's spoken language and its check. A new preview (another link) starts over and
 *  cancels a running check; a stale answer never lands (sequence guard, as the preview's). */
export function useLinkLanguage(args: {
  url: string | null;
  preview: UrlPreview | null;
  serverUrl: string;
  backendId?: string;
  /** The check is offered: the server has it and the link has site subtitles to match. */
  enabled: boolean;
  /** The Whisper model the run would use. */
  model?: string;
  /** The screen's spoken-picker value. */
  screen: string;
}): LinkLanguage {
  const { url, preview, serverUrl, backendId, enabled, model, screen } = args;
  const [edited, setEdited] = useState<string | null>(null);
  const [check, setCheck] = useState<LinkLanguageCheck>({ state: "idle" });
  const seq = useRef(0);
  const inFlight = useRef<{ serverUrl: string; backendId?: string; progressId: string } | null>(null);

  const cancel = useCallback(() => {
    seq.current++;
    const f = inFlight.current;
    inFlight.current = null;
    if (f) void cancelTextTranslation(f).catch(() => {});
  }, []);

  const start = useCallback(() => {
    cancel();
    if (!url || !enabled) return;
    const s = seq.current;
    const progressId = crypto.randomUUID().replace(/-/g, "");
    inFlight.current = { serverUrl, backendId, progressId };
    setCheck({ state: "running" });
    urlLanguageCheck({ serverUrl, backendId, url, model, progressId })
      .then((result) => {
        if (seq.current !== s) return;
        inFlight.current = null;
        setCheck({ state: "done", result });
      })
      .catch((e) => {
        if (seq.current !== s) return;
        inFlight.current = null;
        setCheck({ state: "failed", error: safeDisplayText(String(e).replace(/^Error:\s*/, ""), 200) });
      });
  }, [cancel, url, enabled, serverUrl, backendId, model]);

  // Each preview is a new link: start over. The check runs by itself only when the site names
  // no language and the screen has not fixed one either (⟳ forces it).
  useEffect(() => {
    setEdited(null);
    setCheck({ state: "idle" });
    const fixed = namedLanguage(screen);
    if (preview && !preview.language && !fixed) start();
    else cancel();
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per preview
  }, [preview]);

  const sp = linkSpoken({ siteLanguage: preview?.language, check, screen, edited });
  return {
    sp,
    check,
    enabled,
    pick: (v) => setEdited(v),
    reset: () => setEdited(null),
    recheck: start,
    prefetchMediaId: check.state === "done" ? check.result?.media_id ?? null : null,
  };
}

const minSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const iconButton =
  "ring-signal grid size-8 place-items-center rounded-lg border border-line-strong bg-surface-2 text-dim enabled:hover:border-accent/45 enabled:hover:text-accent";

export function SpokenLanguageRow({
  lang,
  extractor,
  multiOffered,
  disabled,
}: {
  lang: LinkLanguage;
  extractor?: string | null;
  multiOffered: boolean;
  disabled?: boolean;
}) {
  const { sp, check } = lang;
  const running = check.state === "running";
  const pill = spokenPill(sp, check, extractor);
  const r = check.state === "done" ? check.result : undefined;
  const checkLabel = running
    ? "Checking the audio…"
    : check.state === "done"
      ? "Check the audio again"
      : "Check the audio with Whisper";
  const resetLabel = sp.base ? `Back to ${languageLabel(sp.base)}` : "Back to detection";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-2/40 px-3 py-2">
      <span className="text-[12px] font-medium text-dim">Spoken language</span>
      <div className="w-48">
        <SpokenLanguagePicker
          ariaLabel="Spoken language"
          value={sp.value}
          onChange={lang.pick}
          multi={multiOffered}
          disabled={disabled}
        />
      </div>
      {running && (
        <span role="status" aria-label="Detecting the spoken language" className="text-accent">
          <Loader2 className="size-4 animate-spin" />
        </span>
      )}
      {pill && (
        <span
          title={pill.title}
          className={cn(
            "rounded-pill border px-2 py-px text-[11.5px]",
            pill.tone === "edited"
              ? "border-accent/45 bg-accent-soft text-accent"
              : pill.tone === "mixed"
                ? "border-warn/45 bg-warn/10 text-warn"
                : "border-line bg-surface-2 text-dim",
          )}
        >
          {pill.text}
        </span>
      )}
      {r && r.pieces.length > 0 && (
        <span className="flex flex-wrap gap-1.5">
          {r.pieces.map((p) => (
            <span
              key={p.at}
              title={`20 s from ${minSec(p.at)}: ${p.language ? languageLabel(p.language) : "no speech"}, ${Math.round(p.probability * 100)}% sure`}
              className={cn(
                "rounded-md border px-1.5 font-mono text-[10.5px]",
                p.language && p.language !== r.language ? "border-warn/45 text-warn" : "border-line text-dim",
              )}
            >
              {minSec(p.at)} {(p.language ?? "–").toUpperCase()} {Math.round(p.probability * 100)}%
            </span>
          ))}
        </span>
      )}
      <span className="ml-auto flex gap-1">
        <button
          type="button"
          className={cn(iconButton, !lang.enabled && "invisible")}
          disabled={running || disabled || !lang.enabled}
          aria-label={checkLabel}
          title={checkLabel}
          onClick={lang.recheck}
        >
          <RefreshCw className={cn("size-3.5", running && "animate-spin")} />
        </button>
        <button
          type="button"
          className={cn(iconButton, sp.source !== "edited" && "invisible")}
          disabled={disabled || sp.source !== "edited"}
          aria-label={resetLabel}
          title={resetLabel}
          onClick={lang.reset}
        >
          <RotateCcw className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
