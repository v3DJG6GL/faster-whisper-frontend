// The microphone picker (Settings → Audio): the row's dropdown, opened as a listbox so its rows
// can say more than a name — what "System default" resolves to, a Bluetooth chip, a pinned mic
// that isn't connected, and (Linux, behind the switch at the bottom of the menu) every path into
// each mic, labelled by what it does. Rows come from lib/micOptions (pure, tested); this file is
// the interaction.
//
// Keyboard: the trigger opens on Enter / Space / ArrowDown; inside, focus sits on the listbox
// and ArrowUp/Down / Home / End move the active row (aria-activedescendant), Enter / Space pick
// it, Escape closes back to the trigger. Tab moves on to the paths switch at the foot of the
// menu when it is there (Shift+Tab back to the list); Tab from the switch, or from a list with
// no switch, closes and moves on to the next control.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bluetooth, Check, Mic, SlidersHorizontal } from "lucide-react";
import { Badge, FieldTrigger, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { navKey, pickerKeyActsOnce } from "@/lib/listNav";
import { buildMicView, isSelectable, micFootKey, type MicRow, type SelectableRow } from "@/lib/micOptions";
import { safeDisplayText } from "@/lib/sanitize";
import { useOutsidePress } from "@/lib/useOutsidePress";
import type { MicInventory } from "@/lib/types";

const LABEL_MAX = 80;

export function MicPicker({
  inv,
  value,
  savedLabel,
  advanced,
  pathsListed = true,
  onAdvancedChange,
  onPick,
  disabled,
  className,
}: {
  inv: MicInventory | null;
  value: string | null;
  savedLabel: string | null | undefined;
  advanced: boolean;
  /** False while `inv` is a listing fetched without the paths: the toggle shows `advanced`, but
   *  the path rows wait for the listing that carries them. */
  pathsListed?: boolean;
  onAdvancedChange: (on: boolean) => void;
  onPick: (id: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const showPaths = advanced && pathsListed;
  const view = useMemo(() => buildMicView(inv, value, savedLabel, showPaths), [inv, value, savedLabel, showPaths]);
  const choices = view.rows.filter(isSelectable);
  const selectedIndex = Math.max(
    0,
    choices.findIndex((r) => r.value === value),
  );
  // `active` clamped to the current list: it shrinks under an open menu when the advanced
  // toggle goes off or a device drops out on a re-list.
  const activeIdx = Math.min(active, Math.max(0, choices.length - 1));

  useOutsidePress([rootRef], open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [open]);

  // Keep the active row in view while moving through a long (advanced) list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${uid}-opt-${activeIdx}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx, uid]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (r: SelectableRow) => {
    onPick(r.value);
    close(true);
  };

  const onListKey = (e: KeyboardEvent) => {
    // A held Enter / Space acts once, as in ListPicker: otherwise its repeat reaches the refocused
    // trigger, reopens the menu, and the next repeat picks again. The arrows keep repeating.
    if (e.repeat && pickerKeyActsOnce(e.key, false, true)) {
      e.preventDefault();
      return;
    }
    const next = navKey(e.key, activeIdx, choices.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      const r = choices[activeIdx];
      if (r) pick(r);
    } else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") {
      // Into the switch, keeping the menu open: closing first would unmount it under the focus move.
      const sw = e.shiftKey ? null : footRef.current?.querySelector("button");
      if (!sw) {
        setOpen(false);
        return;
      }
      sw.focus();
    } else return;
    e.preventDefault();
  };
  const onFootKey = (e: KeyboardEvent) => {
    const act = micFootKey(e.key, e.shiftKey);
    if (act === "leave") {
      // No refocus, no preventDefault: the browser's own Tab moves on, as from a switchless list.
      setOpen(false);
      return;
    }
    if (act === "list") listRef.current?.focus();
    else if (act === "close") close(true);
    else return;
    e.preventDefault();
  };

  let n = -1; // index among selectable rows while rendering
  const renderRow = (r: MicRow, i: number) => {
    if (r.type === "group") {
      return (
        <li key={`g${i}`} role="presentation" className="px-2.5 pb-1 pt-3 text-[11px] text-faint">
          {safeDisplayText(r.label, LABEL_MAX)}
        </li>
      );
    }
    if (r.type === "note") {
      return (
        <li key={`n${i}`} role="presentation" className="px-2.5 py-1.5 text-[12px] text-faint">
          {r.label}
        </li>
      );
    }
    n += 1;
    const idx = n;
    // A mic's id can also be one of its paths (the server path; the first card path with no
    // sound server), so mark only the first row holding the value — the mic row, which leads.
    // The value check stays: selectedIndex falls back to 0 when nothing matches.
    const selected = r.value === value && idx === selectedIndex;
    const isActive = idx === activeIdx;
    const prev = view.rows[i - 1];
    const divider = r.type === "mic" && prev?.type === "default";
    return (
      <li
        key={`${r.type}:${r.value ?? "default"}`}
        id={`${uid}-opt-${idx}`}
        role="option"
        aria-selected={selected}
        onMouseEnter={() => setActive(idx)}
        onClick={() => pick(r)}
        className={cn(
          "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5",
          divider && "mt-1",
          isActive && "bg-surface-2",
          selected && "bg-accent-soft",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-faint">
          {r.type === "default" ? (
            <SlidersHorizontal className="size-3.5" />
          ) : r.type === "mic" ? (
            r.bluetooth ? <Bluetooth className="size-3.5" /> : <Mic className="size-3.5" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px]", r.type === "mic" && r.missing ? "text-dim" : "text-text")}>
            {safeDisplayText(r.label, LABEL_MAX)}
          </span>
          {r.type === "default" && <span className="block text-[11.5px] text-dim">{r.sub}</span>}
          {r.type === "mic" && r.missing && (
            <span className="block text-[11.5px] text-warn">
              {view.legacy
                ? "Not offered by the sound server — opens through its sound card while plugged in"
                : "Not connected — using System default until it is back"}
            </span>
          )}
          {r.type === "path" && (
            <span className="block truncate font-mono text-[11px] text-dim">{safeDisplayText(r.techId, LABEL_MAX)}</span>
          )}
        </span>
        {r.type === "mic" && r.bluetooth && <Badge>Bluetooth</Badge>}
        {r.type === "path" && <Badge tone={r.server ? "accent" : undefined}>{r.badge}</Badge>}
        <Check className={cn("size-3.5 shrink-0 text-accent", !selected && "invisible")} />
      </li>
    );
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <FieldTrigger
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        open={open}
        aria-controls={open ? `${uid}-list` : undefined}
        aria-label={`Microphone: ${view.triggerLabel}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // The repeat of the Enter / Space that picked and closed lands here: it would reopen.
          if (e.repeat && pickerKeyActsOnce(e.key, false, true)) {
            e.preventDefault();
            return;
          }
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        muted={view.missing}
      >
        {safeDisplayText(view.triggerLabel, LABEL_MAX)}
      </FieldTrigger>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-line-strong bg-panel p-1.5 shadow-lg">
          <ul
            ref={listRef}
            id={`${uid}-list`}
            role="listbox"
            aria-label="Microphone"
            tabIndex={-1}
            aria-activedescendant={`${uid}-opt-${activeIdx}`}
            onKeyDown={onListKey}
            className="max-h-[360px] overflow-auto outline-none"
          >
            {view.rows.map(renderRow)}
          </ul>
          {inv?.advancedSupported && (
            <div
              ref={footRef}
              onKeyDown={onFootKey}
              // A click flips the switch without taking focus off the list (arrows, Escape).
              onMouseDown={(e) => e.preventDefault()}
              className="mt-1.5 flex items-start gap-3 border-t border-line px-2.5 pb-1 pt-2.5 text-[12px] text-dim"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-text">Show all audio paths (advanced)</span>
                Direct ALSA paths skip {inv.server ?? "the sound server"}. Use one only if a mic does not work
                otherwise. Exclusive paths block the mic for other apps.
              </span>
              <Toggle checked={advanced} onChange={onAdvancedChange} ariaLabel="Show all audio paths" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
