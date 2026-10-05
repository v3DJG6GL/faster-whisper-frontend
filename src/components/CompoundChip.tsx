// One language as a compound chip (D86/D88): its code segment, then one part per source, each
// in its source's colour while on and "+ …" in the faint tone while off. Shared by the
// Translate-into chips and the export's Tracks chips so a source reads the same in both.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { sourceTone } from "@/components/SiteSubtitlesPanel";
import { cn } from "@/lib/cn";
import type { ChipPart } from "@/lib/siteSubtitles";

export function CompoundChip({
  head,
  parts,
  onPart,
  disabled,
  muted,
  className,
  partProps,
}: {
  /** The code segment (a button of the caller's). */
  head: ReactNode;
  parts: ChipPart[];
  onPart?: (key: string) => void;
  disabled?: boolean;
  /** Nothing of it is on: the outline goes quiet. */
  muted?: boolean;
  className?: string;
  /** More props for one part (drag, keys, a drop indicator's class). */
  partProps?: (p: ChipPart, i: number) => ButtonHTMLAttributes<HTMLButtonElement> & { ref?: (el: HTMLButtonElement | null) => void };
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-stretch overflow-hidden rounded-pill border",
        muted ? "border-line" : "border-accent/50",
        className,
      )}
    >
      {head}
      {parts.map((p, i) => {
        const extra = partProps?.(p, i);
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            title={p.title}
            aria-pressed={p.on}
            onClick={() => onPart?.(p.key)}
            {...extra}
            className={cn(
              "ring-signal whitespace-nowrap border-l border-line px-2.5 text-[11.5px] enabled:hover:brightness-125",
              p.on ? sourceTone(p.kind, p.hoh) : "text-faint enabled:hover:text-text",
              extra?.className,
            )}
          >
            {p.text}
          </button>
        );
      })}
    </span>
  );
}
