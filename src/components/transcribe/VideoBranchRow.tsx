import { Check, Film } from "lucide-react";
import { fmtBytes } from "@/lib/format";
import { safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";
import { type VideoProgress } from "@/lib/types";
import { aboutLeft, fmtElapsed, STAGE_COLORS } from "@/components/transcribe/railTheme";

/** The Video row: the kept copy's own download, hanging off the Audio
 *  stage by a dashed connector — its own status word, its own clock, a
 *  thinner bar. Past an approximate total the bar holds at 99 % and the
 *  label says what arrived, never a number the picture contradicts. */
export function VideoBranchRow({
  v,
  dlStart,
  now,
  onRetry,
}: {
  v: VideoProgress;
  dlStart?: number;
  now: number;
  onRetry?: () => void;
}) {
  const terminal = v.state === "done" || v.state === "failed" || v.state === "cancelled";
  const elapsed = dlStart ? Math.max(0, now - dlStart) : 0;
  const total = v.totalBytes ?? null;
  const got = v.downloadedBytes ?? 0;
  const over = v.state === "downloading" && !!total && got >= total;
  const rate =
    v.state === "downloading" && got > 0 && elapsed > 5000 ? got / (elapsed / 1000) : null;
  const left =
    !over && rate && total && got < total ? ((total - got) / rate) * 1000 : null;
  const fill =
    v.state === "downloading"
      ? over ? 0.99
        : Math.max(0.02, Math.min(0.99, typeof v.progress === "number" ? v.progress : total ? got / total : 0.02))
      : 1;
  const busy = v.state === "queued" || v.state === "merging" || v.state === "registering";
  const codec = v.vcodec ? v.vcodec.split(".")[0].replace(/^vp09$/, "vp9").replace(/^av01$/, "av1") : null;
  const spec = [v.label, codec, v.container].filter(Boolean).map((x) => safeDisplayText(String(x), 20)).join(" · ");
  const tone =
    v.state === "failed" ? "text-warn" : v.state === "done" ? "text-ok" : "text-faint";
  const word =
    v.state === "queued" ? "queued"
      : v.state === "downloading" ? "downloading"
        : v.state === "merging" ? "merging"
          : v.state === "registering" ? "saving"
            : v.state;
  return (
    <div className="relative flex gap-3.5 border-b border-line py-3 pl-0 last:border-b-0">
      <span className="absolute left-3 top-0 h-2.5 border-l border-dashed border-line-strong" aria-hidden />
      <span
        className={cn(
          "mt-1 grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] border-dashed",
          v.state === "done" ? "border-ok/60 text-ok"
            : v.state === "failed" ? "border-warn/60 text-warn"
              : "border-line-strong text-[color:var(--c-download)]",
        )}
      >
        {v.state === "done" ? <Check className="size-3.5" /> : <Film className="size-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-dim">
            Video
            {v.state === "failed" && v.error ? (
              <span className="font-normal text-faint"> — {safeDisplayText(v.error, 120)}</span>
            ) : null}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
            <span className={tone}>{word}</span>
            {elapsed > 0 || terminal ? ` · ${fmtElapsed(elapsed)}` : ""}
          </span>
        </div>
        {!terminal && (
          <div
            role="progressbar"
            aria-label="Video"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={v.state === "downloading" && !over ? Math.round(fill * 100) : undefined}
            className="mt-2 h-1 overflow-hidden rounded-pill bg-surface-2"
          >
            <div
              className={cn(
                "h-full rounded-pill transition-[width] duration-500",
                (busy || over) && "animate-pulse motion-reduce:animate-none motion-reduce:opacity-80",
              )}
              style={{
                width: `${Math.round(fill * 100)}%`,
                background: STAGE_COLORS.downloading,
                opacity: 0.85,
              }}
            />
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] tabular-nums text-faint">
          {spec ? <span>{spec}</span> : null}
          {v.state === "downloading" && (
            <>
              <span>
                <span className="text-text">{fmtBytes(got)}</span>
                {over
                  ? " received · finishing…"
                  : total ? ` of ${v.totalApprox ? "≈" : ""}${fmtBytes(total)}` : ""}
              </span>
              {rate ? <span>{fmtBytes(rate)}/s</span> : null}
              {left !== null && left > 0 ? <span>{aboutLeft(left)}</span> : null}
            </>
          )}
          {v.state === "queued" && <span>waiting for a download slot…</span>}
          {v.state === "done" && (
            <>
              {v.bytes ? (
                <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[10.5px] text-dim">
                  <span className="font-medium text-text">{fmtBytes(v.bytes)}</span>
                </span>
              ) : null}
              {v.bytes && elapsed > 1000 ? (
                <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[10.5px] text-dim">
                  <span className="font-medium text-text">{fmtBytes(v.bytes / (elapsed / 1000))}/s</span> avg
                </span>
              ) : null}
            </>
          )}
          {v.state === "failed" && (
            <>
              <span className="rounded-md bg-warn/15 px-2 py-0.5 text-[10.5px] text-warn">the transcript is unaffected</span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="ring-signal rounded-md border border-line-strong px-2 py-0.5 text-[10.5px] text-text hover:bg-surface-2"
                >
                  Try again
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
