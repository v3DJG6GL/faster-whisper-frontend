// The export's Tracks chips: one compound chip per language — its code switches the
// whole language, each part one track — and the track order: a chip dragged (or its code
// moved with Alt+←/→) reorders the languages, a part dragged (Alt+←/→ on it) reorders the
// tracks inside its language. Pointer events, not HTML5 drag and drop: WebKitGTK's DnD is
// unreliable in the webview. Every rule lives in lib/transcript/exportTracks.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CompoundChip } from "@/components/CompoundChip";
import { cn } from "@/lib/cn";
import {
  dropSlotAt, languageGroups, moveLanguage, moveTrack, sourceKind, sourceWord, stepSlot, toggleLanguage, toggleTrack,
  trackInfo,
} from "@/lib/transcript/exportTracks";
import { langCode, trackLanguageName } from "@/lib/languages";
import type { ChipPart } from "@/lib/transcript/siteSubtitles";
import type { BatchResult } from "@/lib/types";

interface Drag {
  kind: "lang" | "track";
  /** The language (kind "lang") or the track id. */
  id: string;
  x: number;
  y: number;
  /** Past the few pixels that still make it a click. */
  active: boolean;
  /** The drop slot (moveItem) under the pointer. */
  slot: number | null;
}

/** A slot that moves nothing (right before or after the dragged item) shows no indicator. */
const moves = (slot: number | null, from: number): slot is number => slot !== null && slot !== from && slot !== from + 1;

export function ExportTrackChips({
  result,
  order,
  chosen,
  onChosen,
  onOrder,
}: {
  result: BatchResult;
  /** Every track of the transcript, in track order. */
  order: string[];
  /** The tracks the export carries. */
  chosen: string[];
  onChosen: (next: string[]) => void;
  onOrder: (next: string[]) => void;
}) {
  const groups = languageGroups(result, order);
  const chipEls = useRef(new Map<string, HTMLElement | null>());
  const partEls = useRef(new Map<string, HTMLElement | null>());
  const drag = useRef<Drag | null>(null);
  const [shown, setShown] = useState<Pick<Drag, "kind" | "id" | "slot"> | null>(null);
  // The click a drag ends with is not a toggle; cleared by the next press either way.
  const dragged = useRef(false);
  // The element a keyboard move should keep focused once the chips re-render.
  const refocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    refocus.current?.focus();
    refocus.current = null;
  }, [order]);

  /** Hand on an order that actually moved something: a step past the edge or a drop on
   *  the item's own slot yields an equal copy, and every onOrder rewrites the record. */
  const reorder = (next: string[]): boolean => {
    if (next.length === order.length && next.every((x, i) => x === order[i])) return false;
    onOrder(next);
    return true;
  };
  const press = (kind: Drag["kind"], id: string) => (e: PointerEvent<HTMLElement>) => {
    dragged.current = false;
    if (e.button !== 0) return;
    drag.current = { kind, id, x: e.clientX, y: e.clientY, active: false, slot: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const slide = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || (!d.active && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5)) return;
    d.active = true;
    const els = d.kind === "lang"
      ? groups.map((g) => chipEls.current.get(g.lang))
      : (groups.find((g) => g.tracks.includes(d.id))?.tracks ?? []).map((t) => partEls.current.get(t));
    const slot = dropSlotAt(els.map((el) => el?.getBoundingClientRect()), e.clientX, e.clientY);
    d.slot = slot;
    const { kind, id } = d;
    // Same slot: keep the state object, so the row doesn't re-render at pointer rate.
    setShown((s) => (s && s.kind === kind && s.id === id && s.slot === slot ? s : { kind, id, slot }));
  };
  const release = () => {
    const d = drag.current;
    drag.current = null;
    setShown(null);
    if (!d?.active) return;
    dragged.current = true;
    if (d.slot !== null) {
      reorder(d.kind === "lang" ? moveLanguage(result, order, d.id, d.slot) : moveTrack(result, order, d.id, d.slot));
    }
  };
  // An aborted gesture (system pen/touch takeover) moves nothing, and no click follows it.
  const cancel = () => {
    drag.current = null;
    setShown(null);
  };
  const dragProps = (kind: Drag["kind"], id: string) => ({
    onPointerDown: press(kind, id),
    onPointerMove: slide,
    onPointerUp: release,
    onPointerCancel: cancel,
  });
  /** Alt+←/→: one step left or right. */
  const keyMove = (e: KeyboardEvent<HTMLElement>, from: number, move: (slot: number) => string[]) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    // Refocus only after a real move: a stale target would steal focus on the next order change.
    const el = e.currentTarget;
    if (reorder(move(stepSlot(from, e.key === "ArrowLeft" ? -1 : 1)))) refocus.current = el;
  };
  const pick = (next: string[] | null) => {
    if (dragged.current) dragged.current = false;
    else if (next) onChosen(next);
  };

  const bar = "pointer-events-none absolute inset-y-0.5 w-0.5 rounded-full bg-accent";
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tracks">
      {groups.map((g, gi) => {
        const on = g.tracks.some((t) => chosen.includes(t));
        const name = trackLanguageName(g.lang);
        const langDrag = shown?.kind === "lang" ? groups.findIndex((x) => x.lang === shown.id) : -1;
        const before = langDrag >= 0 && moves(shown!.slot, langDrag) && shown!.slot === gi;
        const after = langDrag >= 0 && moves(shown!.slot, langDrag) && shown!.slot === groups.length && gi === groups.length - 1;
        const trackDrag = shown?.kind === "track" && g.tracks.includes(shown.id) ? g.tracks.indexOf(shown.id) : -1;
        const parts: ChipPart[] = g.tracks.map((t) => {
          const info = trackInfo(result, t);
          const word = sourceWord(info);
          const pOn = chosen.includes(t);
          return {
            kind: sourceKind(info), hoh: info.hoh, on: pOn, key: t,
            text: word,
            title: `${pOn ? "Leave out" : "Add"} ${name} · ${word} — drag to reorder`,
          };
        });
        return (
          <span
            key={g.lang}
            ref={(el) => { chipEls.current.set(g.lang, el); }}
            className={cn("relative inline-flex", langDrag === gi && "opacity-50")}
            title="Drag to reorder"
          >
            {before && <span aria-hidden className={cn(bar, "-left-[5px]")} />}
            <CompoundChip
              muted={!on}
              head={
                <button
                  type="button"
                  aria-pressed={on}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                  title={`${on ? "Leave out" : "Add"} ${name} — drag to reorder`}
                  onClick={() => pick(toggleLanguage(result, order, chosen, g.lang))}
                  onKeyDown={(e) => keyMove(e, gi, (slot) => moveLanguage(result, order, g.lang, slot))}
                  {...dragProps("lang", g.lang)}
                  className={cn(
                    "ring-signal inline-flex cursor-grab touch-none items-center px-2.5 font-mono text-[11.5px] font-medium",
                    on ? "text-accent" : "text-faint hover:text-text",
                  )}
                >
                  {langCode(g.lang)}
                </button>
              }
              parts={parts}
              onPart={(t) => pick(toggleTrack(order, chosen, t))}
              partProps={(p, i) => ({
                ref: (el) => { partEls.current.set(p.key, el); },
                "aria-keyshortcuts": "Alt+ArrowLeft Alt+ArrowRight",
                onKeyDown: (e) => keyMove(e, i, (slot) => moveTrack(result, order, p.key, slot)),
                ...dragProps("track", p.key),
                className: cn(
                  "cursor-grab touch-none",
                  trackDrag === i && "opacity-50",
                  trackDrag >= 0 && moves(shown!.slot, trackDrag) && (shown!.slot === i
                    ? "shadow-[inset_2px_0_0_var(--c-accent)]"
                    : shown!.slot === g.tracks.length && i === g.tracks.length - 1 && "shadow-[inset_-2px_0_0_var(--c-accent)]"),
                ),
              })}
            />
            {after && <span aria-hidden className={cn(bar, "-right-[5px]")} />}
          </span>
        );
      })}
    </div>
  );
}
