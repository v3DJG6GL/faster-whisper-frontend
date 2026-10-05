import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { fmtBitrate, fmtBytes } from "@/lib/format";
import { rungFacts, tierWords, type VideoRung } from "@/lib/urlSource";
import { safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";
import { useOutsidePress } from "@/lib/useOutsidePress";

/** The link card's quality picker (D67 B): a listbox whose rows carry the
 *  tier word on top and the facts beneath — resolution, bitrate, size,
 *  container — so nothing truncates and each rung reads in one glance. The
 *  ladder arrives rank-ordered from the server; the tier words follow that
 *  order and never repeat (tierWords). */
export function RungPicker({
  ladder,
  chosen,
  onChange,
}: {
  ladder: VideoRung[];
  chosen: VideoRung | null;
  onChange: (rung: VideoRung) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rungs = ladder.filter((r) => r.kind === "video");
  const words = tierWords(rungs.length);
  const idx = Math.max(0, chosen ? rungs.indexOf(chosen) : 0);
  const cur = rungs[idx];
  useOutsidePress([ref], open, () => setOpen(false));
  const fmt = { bytes: fmtBytes, bitrate: fmtBitrate };
  const spec = (r: VideoRung) =>
    r.note && r.label ? r.label.replace(r.note, "").trim() : r.label ?? "";
  const move = (dir: 1 | -1) => {
    let i = idx;
    for (let n = 0; n < rungs.length; n++) {
      i = Math.min(rungs.length - 1, Math.max(0, i + dir));
      if (!rungs[i]?.over_cap) break;
    }
    if (rungs[i] && !rungs[i].over_cap) onChange(rungs[i]);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Video quality"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        }}
        className="ring-signal inline-flex h-9 min-w-[250px] items-center justify-between gap-3 rounded-xl border border-line-strong bg-surface-2 px-3 text-[13px] text-text"
      >
        <span className="truncate">
          {words[idx] ? `${words[idx]}${rungs.length > 1 ? " quality" : ""}` : "Quality"}
          {cur && spec(cur) ? <span className="text-dim"> · {safeDisplayText(spec(cur), 20)}</span> : null}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-faint" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Video quality"
          className="absolute left-0 top-full z-20 mt-1 max-h-[340px] w-[400px] overflow-auto rounded-xl border border-line-strong bg-panel p-1.5 shadow-lg"
        >
          {rungs.map((r, i) => {
            const selected = i === idx;
            const facts = rungFacts({ ...r, label: spec(r) }, fmt);
            return (
              <li
                key={r.format_id ?? `${r.height ?? "best"}-${i}`}
                role="option"
                aria-selected={selected}
                aria-disabled={!!r.over_cap}
                onClick={() => {
                  if (r.over_cap) return;
                  onChange(r);
                  setOpen(false);
                }}
                className={cn(
                  "cursor-pointer rounded-lg px-2.5 py-1.5",
                  selected && "bg-accent-soft",
                  r.over_cap && "cursor-not-allowed opacity-50",
                )}
              >
                <div className="flex items-baseline gap-2 text-[13px] text-text">
                  {words[i] ? `${words[i]}${rungs.length > 1 ? " quality" : ""}` : "\u00a0"}
                  {r.note && (
                    <span className="rounded-md bg-[color:var(--c-download)]/15 px-1.5 font-mono text-[10px] uppercase tracking-label text-[color:var(--c-download)]">
                      {safeDisplayText(r.note, 10)}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-dim">
                  {safeDisplayText(facts, 64)}
                  {r.over_cap ? " · over the server limit" : ""}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
