// The microphone picker (Settings → Audio). Design "Microphone Paths", D74 A: the dropdown the
// row always had, opened as a listbox so its rows can say more than a name — what "System
// default" resolves to, a Bluetooth chip, a pinned mic that isn't connected, and (Linux, behind
// the switch at the bottom of the menu) every path into each mic, labelled by what it does.
// Rows come from lib/micOptions (pure, tested); this file is the interaction.
//
// Keyboard: the trigger opens on Enter / Space / ArrowDown; inside, focus sits on the listbox
// and ArrowUp/Down / Home / End move the active row (aria-activedescendant), Enter / Space pick
// it, Escape closes back to the trigger, Tab closes.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bluetooth, Check, Mic, SlidersHorizontal } from "lucide-react";
import { Badge, FieldTrigger, Toggle } from "@/components/ui";
import { cn } from "@/lib/cn";
import { buildMicView, isSelectable, type MicRow, type SelectableRow } from "@/lib/micOptions";
import { safeDisplayText } from "@/lib/sanitize";
import { useOutsidePress } from "@/lib/useOutsidePress";
import type { MicInventory } from "@/lib/types";

const LABEL_MAX = 80;

export function MicPicker({
  inv,
  value,
  savedLabel,
  advanced,
  onAdvancedChange,
  onPick,
  disabled,
  className,
}: {
  inv: MicInventory | null;
  value: string | null;
  savedLabel: string | null | undefined;
  advanced: boolean;
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
  const uid = useId();
  const view = useMemo(() => buildMicView(inv, value, savedLabel, advanced), [inv, value, savedLabel, advanced]);
  const choices = view.rows.filter(isSelectable);
  const selectedIndex = Math.max(
    0,
    choices.findIndex((r) => r.value === value),
  );

  useOutsidePress([rootRef], open, () => setOpen(false));

  // Opening focuses the list on the current choice.
  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    listRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [open]);

  // Keep the active row in view while moving through a long (advanced) list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${uid}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, uid]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (r: SelectableRow) => {
    onPick(r.value);
    close(true);
  };

  const onListKey = (e: KeyboardEvent) => {
    const last = choices.length - 1;
    if (e.key === "ArrowDown") setActive((i) => Math.min(last, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") {
      const r = choices[active];
      if (r) pick(r);
    } else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") {
      setOpen(false);
      return;
    } else return;
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
    const selected = r.value === value;
    const isActive = idx === active;
    const prev = view.rows[i - 1];
    const divider =
      (r.type === "mic" && prev?.type === "default") || (r.type === "path" && prev?.type === "mic");
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
          <span className={cn("block truncate text-[13px] text-text", r.type === "mic" && r.missing && "text-dim")}>
            {safeDisplayText(r.label, LABEL_MAX)}
          </span>
          {r.type === "default" && <span className="block text-[11.5px] text-dim">{r.sub}</span>}
          {r.type === "mic" && r.missing && (
            <span className="block text-[11.5px] text-warn">
              Not connected — using System default until it is back
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
        aria-controls={open ? `${uid}-list` : undefined}
        aria-label={`Microphone: ${view.triggerLabel}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(view.missing && "text-dim")}
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
            aria-activedescendant={`${uid}-opt-${active}`}
            onKeyDown={onListKey}
            className="max-h-[360px] overflow-auto outline-none"
          >
            {view.rows.map(renderRow)}
          </ul>
          {inv?.advancedSupported && (
            <div className="mt-1.5 flex items-start gap-3 border-t border-line px-2.5 pb-1 pt-2.5 text-[12px] text-dim">
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
