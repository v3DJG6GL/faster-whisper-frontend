// A searchable, grouped list in a popover — the shell of the language pickers (D87).
//
// The trigger is the caller's (renderTrigger), so a chip row's "+ language", a form field and a
// table's "Add language" row can all open the same list. Inside, focus never leaves the search
// field: ↑↓ / PageUp / PageDown / Home / End move the highlighted row (aria-activedescendant),
// Enter picks it and closes, Space ticks it in a multi-select list (only while the search is
// empty — a space can be part of a name), Esc closes back to the trigger, Tab and a click outside
// just close. ↑↓ on the closed trigger opens it. A short list (`search={false}`, ui/form.tsx's Select)
// has no search field: the listbox itself takes focus and the same keys, Space included.
//
// The popover is PORTALED to <body> and fixed-positioned at the trigger (useAnchoredRect, shared
// with Combobox), so a card's `overflow-hidden` can't crop it; it opens upward when the room
// below is short. Which rows exist and in what order is the caller's pure `sections(query)`.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { comboboxInputProps, navKey, optionId } from "@/lib/listNav";
import { POPOVER_PANEL } from "@/components/styles";
import { Kbd } from "@/components/ui/Kbd";
import { popoverBox, useAnchoredRect } from "@/lib/useAnchoredRect";
import { useOutsidePress } from "@/lib/useOutsidePress";

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
  listboxProps,
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
  /** Focus and keys for a listbox that holds focus itself (no search field to own it). */
  listboxProps?: HTMLAttributes<HTMLDivElement>;
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
    <div
      {...listboxProps}
      id={id}
      role="listbox"
      aria-label={label}
      aria-multiselectable={multi || undefined}
      className={className}
      style={style}
    >
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
      <Kbd size="xs">{k}</Kbd>
      {children}
    </span>
  );
}

/** Popover width floor and list height ceiling (px). */
const MIN_WIDTH = 320;
const MAX_LIST = 470;
/** Search bar + hint line, so the list's height leaves room for both; the hint line alone. */
const CHROME = 96;
const CHROME_BARE = 48;

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
  search = true,
  minWidth = MIN_WIDTH,
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
  /** The search field's placeholder (unused without `search`). */
  placeholder?: string;
  /** What a row is, for the no-match line ("language"). */
  noun?: string;
  /** The hint line under the list. */
  keys: ReactNode;
  disabled?: boolean;
  /** false = no search field; the listbox holds focus and the keys. */
  search?: boolean;
  /** Popover width floor (px); it is never narrower than the trigger. */
  minWidth?: number;
}) {
  const listId = `${useId()}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const rect = useAnchoredRect(triggerRef, open);
  // Without a search field the listbox takes focus once the popover is placed.
  const placed = open && rect !== null;
  useEffect(() => {
    if (placed && !search) document.getElementById(listId)?.focus({ preventScroll: true });
  }, [placed, search, listId]);

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
  useOutsidePress([popRef, triggerRef], open, () => close(false));

  const pick = (r: R, index: number) => {
    setActive(index);
    onPick(r);
    if (!multi) close(true);
  };

  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
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
    } else if (e.key === " " && (multi || !search) && !query) {
      e.preventDefault();
      const r = flat[act];
      if (r) {
        onPick(r);
        if (!multi) close(true);
      }
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
    const box = popoverBox(rect, { minWidth });
    listMax = Math.max(120, Math.min(MAX_LIST, box.room - (search ? CHROME : CHROME_BARE)));
    pos = box.style;
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
            className={POPOVER_PANEL}
          >
            {search && (
              <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-faint">
                <Search className="size-4 shrink-0" aria-hidden />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onListKey}
                  placeholder={placeholder}
                  aria-label={`Search ${label.toLowerCase()}`}
                  {...comboboxInputProps(listId, act, !!flat[act])}
                  spellCheck={false}
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
                />
              </div>
            )}
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
              empty={<div className="px-3 py-4 text-[12.5px] text-dim">No {noun ?? "option"} matches “{query.slice(0, 40)}”.</div>}
              className="overflow-y-auto p-1.5 outline-none"
              style={{ maxHeight: listMax }}
              listboxProps={
                search
                  ? undefined
                  : { tabIndex: -1, "aria-activedescendant": flat[act] ? optionId(listId, act) : undefined, onKeyDown: onListKey }
              }
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
