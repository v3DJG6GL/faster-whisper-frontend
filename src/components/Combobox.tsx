// A small, on-theme ARIA combobox: a Signal TextInput with a type-ahead listbox
// of suggestions. Built for the Dictionary's spoken-symbol (callback:map) KEY
// field — pick from recently-transcribed words instead of typing.
//
// Two structural choices matter:
//  1. Focus-loss safety — the <input> is rendered ONCE here (never wrapped in a
//     per-render component, never remounted on keystroke); the listbox is a
//     separate, conditionally-rendered node. DOM focus stays on the input the
//     whole time; the highlighted option is tracked via `aria-activedescendant`
//     (the WAI-ARIA combobox pattern), not by moving focus.
//  2. No clipping — the popover is PORTALED to <body> and fixed-positioned under
//     the input, so the RuleCard's `overflow-hidden` can't crop it.

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { TextInput } from "@/components/ui";

const MAX_SHOWN = 50; // popover DOM cap (the source list is already server-capped)

/** Prefix matches first, then substring matches; case-insensitive. Empty query
 *  → the list as-is (newest-first from the server). */
function rank(suggestions: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return suggestions.slice(0, MAX_SHOWN);
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const s of suggestions) {
    const i = s.toLowerCase().indexOf(q);
    if (i === 0) prefix.push(s);
    else if (i > 0) substr.push(s);
    if (prefix.length + substr.length >= MAX_SHOWN * 3) break;
  }
  return [...prefix, ...substr].slice(0, MAX_SHOWN);
}

/** Bold the matched span within an option label. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  if (!q) return text;
  // Match against the original text (case-insensitive), not text.toLowerCase(): toLowerCase is not
  // length-preserving (Turkish İ → "i̇" is 1→2 units), so indexing the lowercased string while
  // slicing the original shifts the bold span. A regex on `text` keeps the index and matched length
  // in the same string space; a non-match just renders unbolded.
  const m = text.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  if (!m || m.index === undefined) return text;
  const end = m.index + m[0].length;
  return (
    <>
      {text.slice(0, m.index)}
      <b className="font-semibold">{text.slice(m.index, end)}</b>
      {text.slice(end)}
    </>
  );
}

export function Combobox({
  value, onChange, onSelect, suggestions, disabled, placeholder, className, footerMax, autoFocus,
  openOnFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Called when the user picks a suggestion (Enter/Tab on the active option, or
   *  click). The parent owns committing the value + advancing focus. */
  onSelect: (word: string) => void;
  suggestions: string[];
  disabled?: boolean;
  placeholder?: string;
  /** Applied to the wrapper (e.g. flex sizing); the input itself is w-full. */
  className?: string;
  /** Backend cap (QUICK_CONFIG_WORD_SUGGESTIONS_MAX) — shown as a footer caption. */
  footerMax?: number;
  /** Focus on mount (e.g. a freshly-added row) so suggestions appear at once. */
  autoFocus?: boolean;
  /** Whether *gaining* focus opens the dropdown. Default true. Pass false to focus
   *  the field quietly (e.g. after "add another") — typing, ArrowDown or a click
   *  still open it; only the implicit focus-open is suppressed. */
  openOnFocus?: boolean;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);
  // Set when ArrowDown is pressed before suggestions have loaded — see below.
  const wantFirstRef = useRef(false);

  const candidates = disabled ? [] : rank(suggestions, value);
  const showPopover = open && candidates.length > 0;

  // Position the portaled popover under the input; track scroll/resize while open.
  const place = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.bottom + 4, width: r.width });
  }, []);
  useLayoutEffect(() => {
    if (!showPopover) return;
    place();
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [showPopover, place]);

  // Keep `active` in range, and scroll the highlighted option into view.
  useEffect(() => {
    if (active >= candidates.length) setActive(candidates.length - 1);
  }, [candidates.length, active]);
  useEffect(() => {
    if (showPopover && active >= 0) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, showPopover]);
  // If ArrowDown landed before the suggestions finished loading (a cold-start race —
  // recent words are fetched async), honour it the moment they arrive so the very
  // first press isn't silently swallowed.
  useEffect(() => {
    if (wantFirstRef.current && candidates.length > 0) {
      wantFirstRef.current = false;
      setActive(0);
    }
  }, [candidates.length]);

  function choose(word: string | undefined) {
    // A keyboard pick reads candidates[active]; guard against a stale active index that
    // momentarily exceeds a just-shrunk candidate list (would pass undefined to onSelect).
    if (word == null) return;
    wantFirstRef.current = false;
    setOpen(false);
    setActive(-1);
    onSelect(word);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        // No candidates yet (still loading) → remember the intent; the effect above
        // lands on the first option once they arrive. Otherwise move down — from no
        // selection (-1) the first press lands on index 0.
        if (candidates.length === 0) wantFirstRef.current = true;
        else setActive((a) => (a < 0 ? 0 : Math.min(a + 1, candidates.length - 1)));
        break;
      case "ArrowUp":
        if (open) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
        break;
      case "Enter":
        // Only act when an option is highlighted — otherwise leave the typed key
        // intact (Enter doesn't submit anything in this editor).
        if (showPopover && active >= 0) { e.preventDefault(); choose(candidates[active]); }
        break;
      case "Escape":
        if (open) { e.stopPropagation(); setOpen(false); setActive(-1); }
        break;
      case "Tab":
        // Accept a highlighted option on Tab (fast entry); else just close.
        if (showPopover && active >= 0) { e.preventDefault(); choose(candidates[active]); }
        else { setOpen(false); setActive(-1); }
        break;
    }
  }

  return (
    <div className={cn("relative", className)}>
      <TextInput
        ref={inputRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={showPopover}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPopover && active >= 0 ? optId(active) : undefined}
        onChange={(e) => { wantFirstRef.current = false; onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => { if (!disabled && openOnFocus) setOpen(true); }}
        // A click in an already-focused field (e.g. after Esc closed the popover)
        // doesn't refire onFocus — reopen explicitly so the user can get it back.
        onClick={() => { if (!disabled) setOpen(true); }}
        onBlur={() => { setOpen(false); setActive(-1); }}
        onKeyDown={onKeyDown}
      />
      {showPopover && rect &&
        createPortal(
          <div
            // Keep the input focused for any mouse interaction inside the popover.
            onMouseDown={(e) => e.preventDefault()}
            style={{ position: "fixed", left: rect.left, top: rect.top, minWidth: rect.width, zIndex: 60 }}
            className="animate-combobox-pop overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.55)]"
          >
            <ul id={listId} role="listbox" className="max-h-[14rem] overflow-auto py-1">
              {candidates.map((w, i) => (
                <li
                  key={w}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  ref={i === active ? activeRef : undefined}
                  onMouseDown={() => choose(w)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "cursor-pointer truncate border-l-2 px-3 py-1.5 text-[13px] transition-colors",
                    i === active ? "border-accent bg-accent-soft text-accent" : "border-transparent text-text",
                  )}
                >
                  <Highlight text={w} query={value} />
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-1.5 text-[11px] text-faint">
              <span>recent words{footerMax ? ` · up to ${footerMax}` : ""}</span>
              <span className="font-mono tracking-wide">↑↓ ↵ esc</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
