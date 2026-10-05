// A searchable, grouped list in a popover — the shell of the language pickers (D87).
//
// The trigger is the caller's (renderTrigger), so a chip row's "+ language", a form field and a
// table's "Add language" row can all open the same list. Inside, focus never leaves the search
// field: ↑↓ / PageUp / PageDown / Home / End move the highlighted row (aria-activedescendant),
// Enter picks it and closes, Space ticks it in a multi-select list (only while the search is
// empty — a space can be part of a name), Esc closes back to the trigger, Tab and a click outside
// just close. ↑↓ on the closed trigger opens it.
//
// The popover is PORTALED to <body> and fixed-positioned at the trigger (useAnchoredRect, shared
// with Combobox), so a card's `overflow-hidden` can't crop it; it opens upward when the room
// below is short. Which rows exist and in what order is the caller's pure `sections(query)`.

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { navKey } from "@/lib/listNav";
import { useAnchoredRect } from "@/lib/useAnchoredRect";

export interface PickerSection<R> {
  /** "" = no header (pinned rows). */
  title: string;
  count?: number;
  rows: R[];
}

/** Spread onto the trigger <button> a renderTrigger draws. */
export interface TriggerProps {
  ref: Ref<HTMLButtonElement>;
  type: "button";
  disabled?: boolean;
  "aria-haspopup": "listbox";
  "aria-expanded": boolean;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

export const optionId = (listId: string, i: number) => `${listId}-opt-${i}`;

/** The search field's half of the listbox: it owns focus, the list follows `active`. */
export const comboboxInputProps = (listId: string, active: number, hasRow: boolean) => ({
  role: "combobox" as const,
  "aria-expanded": true,
  "aria-controls": listId,
  "aria-autocomplete": "list" as const,
  "aria-activedescendant": hasRow ? optionId(listId, active) : undefined,
});

/** The grouped listbox: section headers with counts, options with the active one outlined and
 *  kept on screen. Rows never take focus (a mouse press is swallowed so the search field keeps
 *  it). Shared by ListPicker and the dictation LangPick window. */
export function OptionRows<R>({
  id,
  label,
  sections,
  active,
  multi,
  rowKey,
  isSelected,
  onPick,
  renderRow,
  rowTitle,
  empty,
  className,
  style,
}: {
  id: string;
  label: string;
  sections: PickerSection<R>[];
  active: number;
  multi?: boolean;
  rowKey: (r: R) => string;
  isSelected: (r: R) => boolean;
  onPick: (r: R, index: number) => void;
  renderRow: (r: R, state: { selected: boolean; index: number }) => ReactNode;
  /** A row's tooltip. */
  rowTitle?: (r: R) => string | undefined;
  /** Shown when no section has a row. */
  empty?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  // Each section's first flat index — the active row and option ids count across groups.
  const starts: number[] = [];
  let total = 0;
  for (const s of sections) {
    starts.push(total);
    total += s.rows.length;
  }
  // Keyed on the active row too: a new filter can put a different row at the same index.
  const activeRow = sections.flatMap((s) => s.rows)[active];
  const activeKey = activeRow === undefined ? "" : rowKey(activeRow);
  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView({ block: "nearest" });
  }, [id, active, activeKey]);
  return (
    <div id={id} role="listbox" aria-label={label} aria-multiselectable={multi || undefined} className={className} style={style}>
      {total === 0 && empty}
      {sections.map((s, si) => (
        // role="group" owns its options for AT (an option must sit in the listbox or a group of it).
        <div key={`${si}-${s.title}`} role="group" aria-label={s.title || undefined}>
          {s.title && (
            <div aria-hidden className="flex justify-between px-2.5 pb-1 pt-2 text-[11px] text-faint">
              <span>{s.title}</span>
              {s.count !== undefined && <span className="font-mono">{s.count}</span>}
            </div>
          )}
          {s.rows.map((r, ri) => {
            const index = starts[si] + ri;
            const selected = isSelected(r);
            return (
              <div
                key={rowKey(r)}
                id={optionId(id, index)}
                role="option"
                aria-selected={selected}
                title={rowTitle?.(r)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(r, index)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]",
                  selected ? "bg-accent-soft" : "hover:bg-surface-2",
                  index === active && "bg-surface-2 ring-[1.5px] ring-inset ring-accent",
                )}
              >
                {renderRow(r, { selected, index })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** One key and what it does, for a picker's hint line. */
export function KeyHint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-dim">
        {k}
      </kbd>
      {children}
    </span>
  );
}

/** Popover width floor and list height ceiling (px). */
const MIN_WIDTH = 320;
const MAX_LIST = 470;
/** Search bar + hint line, so the list's height leaves room for both. */
const CHROME = 96;

export function ListPicker<R>({
  label,
  sections,
  multi,
  rowKey,
  isSelected,
  onPick,
  renderRow,
  rowTitle,
  renderTrigger,
  onClose,
  placeholder,
  noun,
  keys,
  disabled,
}: {
  /** The list's accessible name ("Spoken language"). */
  label: string;
  /** The rows for a search query (pure; called only while open). */
  sections: (query: string) => PickerSection<R>[];
  multi?: boolean;
  rowKey: (r: R) => string;
  isSelected: (r: R) => boolean;
  /** Single: the pick (the picker then closes). Multi: tick or untick. */
  onPick: (r: R) => void;
  renderRow: (r: R, state: { selected: boolean; index: number }) => ReactNode;
  rowTitle?: (r: R) => string | undefined;
  renderTrigger: (p: TriggerProps) => ReactNode;
  /** After every close — the moment a Recent list may re-sort. */
  onClose?: () => void;
  placeholder: string;
  /** What a row is, for the no-match line ("language"). */
  noun: string;
  /** The hint line under the list. */
  keys: ReactNode;
  disabled?: boolean;
}) {
  const listId = `${useId()}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const rect = useAnchoredRect(triggerRef, open);

  const groups = open ? sections(query) : [];
  const flat = groups.flatMap((g) => g.rows);
  const act = Math.max(0, Math.min(active, flat.length - 1));

  const show = () => {
    if (disabled) return;
    // Start on the current choice, so Enter keeps it and ↑↓ move from it.
    setActive(Math.max(0, sections("").flatMap((g) => g.rows).findIndex(isSelected)));
    setQuery("");
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
    onClose?.();
  };
  // Latest close for the outside-press listener, which is bound once per opening.
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !triggerRef.current?.contains(t)) closeRef.current(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (r: R, index: number) => {
    setActive(index);
    onPick(r);
    if (!multi) close(true);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = navKey(e.key, act, flat.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = flat[act];
      if (r) {
        onPick(r);
        close(true);
      }
    } else if (e.key === " " && multi && !query) {
      e.preventDefault();
      const r = flat[act];
      if (r) onPick(r);
    } else if (e.key === "Escape") {
      // Ours alone: a dialog or editor behind the picker must not take this Esc as its own.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  // Below the trigger, or above it when the room below is short and there is more above.
  let pos: CSSProperties | null = null;
  let listMax = MAX_LIST;
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(rect.width, MIN_WIDTH), vw - 16);
    const below = vh - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 320 && above > below;
    listMax = Math.max(120, Math.min(MAX_LIST, (up ? above : below) - CHROME));
    pos = {
      position: "fixed",
      left: Math.max(8, Math.min(rect.left, vw - width - 8)),
      width,
      zIndex: 70,
      ...(up ? { bottom: vh - rect.top + 4 } : { top: rect.bottom + 4 }),
    };
  }

  return (
    <>
      {renderTrigger({
        ref: triggerRef,
        type: "button",
        disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        onClick: () => (open ? close(false) : show()),
        onKeyDown: (e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        },
      })}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            style={pos}
            className="animate-combobox-pop overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_12px_32px_-8px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-faint">
              <Search className="size-4 shrink-0" aria-hidden />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
                placeholder={placeholder}
                aria-label={`Search ${label.toLowerCase()}`}
                {...comboboxInputProps(listId, act, !!flat[act])}
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
              />
            </div>
            <OptionRows
              id={listId}
              label={label}
              sections={groups}
              active={act}
              multi={multi}
              rowKey={rowKey}
              isSelected={isSelected}
              onPick={pick}
              renderRow={renderRow}
              rowTitle={rowTitle}
              empty={<div className="px-3 py-4 text-[12.5px] text-dim">No {noun} matches “{query.slice(0, 40)}”.</div>}
              className="overflow-y-auto p-1.5"
              style={{ maxHeight: listMax }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-faint">
              {keys}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
