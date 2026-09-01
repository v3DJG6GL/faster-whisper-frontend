// The per-session translation-target picker (Tauri window label `langpick`).
//
// Asks which languages THIS dictation should be turned into, then answers and closes.
// Like Overlay.tsx and QuickAdd.tsx this is a STANDALONE root with its own JS context and
// no store — everything it needs arrives in the `langpick://shown` seed, and its answer
// goes back over `langpick://commit`.
//
// Not a command palette. The candidate set is small and bounded (8 targets out of ~20
// languages), so the fast path is a NUMBERED quick-pick: every candidate keeps a stable
// digit, the profile's own targets are preselected, and the whole decision is "2 3 Enter"
// without looking. Typing still filters, for the long tail.
//
// The rail across the top assembles the same `source → targets` route the chip will show a
// second later — same arrow, same accent — so the picker teaches the chip rather than
// introducing a second vocabulary for one idea. (The accent, not the translate teal: teal is
// the chip's translating STAGE, work in progress; a chosen target is a promise, and the chip
// shows its resolved route in the accent too.)
//
// Three answers, and only three: Enter commits the chosen targets, `0` commits none (insert
// the original only), and Esc / Cancel / a closed window ABORT the whole action — no session
// starts (hands-free), or the finished transcript is not inserted (push-to-talk; it still
// goes to History). There is no "dismiss and quietly use the Profile's preset": every way
// out of this window is a decision the user can see.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abortLangPick, commitLangPick } from "@/lib/api";
import { LANGUAGES, languageLabel } from "@/lib/languages";
import { applyTheme, setAccentHue, setAccentMotion, startAccentDrift, watchSystemTheme, DEFAULT_ACCENT_HUE } from "@/lib/theme";
import { safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";
import type { AccentMotion, ThemeName } from "@/lib/types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Mirrors TRANSLATION_MAX_TARGETS — the server translates every context segment once per
 *  target, so the cost is linear in this number and the cap is a real one. */
const MAX_TARGETS = 8;
/** Recents shown above the full list. Enough to cover a working set without pushing the
 *  alphabetical list off the first screen. */
const MAX_RECENT = 5;

/** What the main window hands over on summon. Every field optional: a malformed seed must
 *  degrade to a usable picker, never a blank window the user can't escape. */
interface Seed {
  /** Spoken language code, for the rail's origin chip. */
  source?: string;
  /** The Profile's configured targets — preselected, so Enter with no keystrokes
   *  reproduces exactly today's behaviour. */
  preset?: string[];
  /** Recently picked codes, most-recent first. */
  recent?: string[];
  /** Profile tag + activation, for the header. */
  tag?: string;
  /** "before" (hands-free, about to start) or "after" (push-to-talk, transcript ready). */
  when?: "before" | "after";
  /** Server-advertised target codes; absent = the app's curated list. */
  allowed?: string[];
  theme?: ThemeName;
  /** Signal colour hue, so the accent-tinted picks match the app. */
  accentHue?: number;
  /** …and its motion: the picker runs the same clock arithmetic, so it drifts in step. */
  accentMotion?: AccentMotion;
}

export default function LangPick() {
  const [seed, setSeed] = useState<Seed>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Bumped per summon so the input remounts and re-focuses even when the window was only
  // hidden (never unmounted) between uses — the same trick QuickAdd uses.
  const [showSeq, setShowSeq] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const themeRef = useRef<ThemeName>("auto");

  useEffect(() => watchSystemTheme(() => themeRef.current), []);
  useEffect(() => startAccentDrift(), []);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<Seed>("langpick://shown", (e) => {
          const s = e.payload ?? {};
          setSeed(s);
          themeRef.current = s.theme ?? "auto";
          setAccentHue(typeof s.accentHue === "number" ? s.accentHue : DEFAULT_ACCENT_HUE);
          setAccentMotion(s.accentMotion);
          applyTheme(s.theme ?? "auto");
          // Preselect the Profile's own targets: Enter with no keystrokes must reproduce
          // what would have happened without the picker. Anything else makes the prompt a
          // trap — confirming it by habit would silently change the outcome. (Esc is the
          // other habit, and it aborts loudly rather than changing anything.)
          setChosen((s.preset ?? []).filter((t) => typeof t === "string").slice(0, MAX_TARGETS));
          setQuery("");
          setActive(0);
          setShowSeq((n) => n + 1);
        }),
      )
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [showSeq]);

  // Logged, never swallowed: Rust owns the hide + the answer event, so a failed invoke leaves
  // the picker up AND the asker pending — the console line is the only trace of why.
  const commit = useCallback(
    (targets: string[]) => void commitLangPick(targets).catch((e) => console.error("lang pick commit failed:", e)),
    [],
  );
  const abort = useCallback(() => void abortLangPick().catch((e) => console.error("lang pick abort failed:", e)), []);
  // Keep the keyboard highlight on screen: arrows/digits move `active`, the list scrolls.
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Candidates: the server's list when it advertises one, else the app's curated set,
  // minus the spoken language (translating a language into itself is a no-op that would
  // still cost a server round-trip per phrase).
  const candidates = useMemo(() => {
    const base = seed.allowed?.length
      ? seed.allowed
      : LANGUAGES.filter((l) => l.value !== "auto").map((l) => l.value);
    return base.filter((c) => typeof c === "string" && c !== seed.source);
  }, [seed.allowed, seed.source]);

  // Recents first, then everything else. Grouped rather than merged: a flat list ranked by
  // recency reorders under the user between summons, and a numbered pick is only fast if
  // the number is where it was last time.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (c: string) =>
      !q || c.toLowerCase().startsWith(q) || languageLabel(c).toLowerCase().startsWith(q);
    const recent = (seed.recent ?? []).filter((c) => candidates.includes(c)).slice(0, MAX_RECENT);
    const rest = candidates.filter((c) => !recent.includes(c));
    return [
      { label: "Recent", items: recent.filter(match) },
      { label: "All languages", items: rest.filter(match) },
    ].filter((g) => g.items.length > 0);
  }, [candidates, seed.recent, query]);

  // Flattened, with the digit each row answers to. Digits follow DISPLAY order so what you
  // see and what you press can't disagree.
  const rows = useMemo(() => {
    const out: { code: string; digit: number | null }[] = [];
    let n = 0;
    for (const g of groups) {
      for (const code of g.items) {
        n += 1;
        out.push({ code, digit: n <= 9 ? n : null });
      }
    }
    return out;
  }, [groups]);

  const toggle = useCallback((code: string) => {
    setChosen((cur) =>
      cur.includes(code)
        ? cur.filter((c) => c !== code)
        : cur.length >= MAX_TARGETS
          ? cur
          : [...cur, code],
    );
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const typing = document.activeElement === inputRef.current && query.length > 0;
    if (e.key === "Escape") {
      // Abort the whole action (don't start / don't insert) — see the header comment.
      abort();
    } else if (e.key === "Enter") {
      commit(chosen);
    } else if (e.key === "ArrowDown") {
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === " " && !typing) {
      if (rows[active]) toggle(rows[active].code);
    } else if (e.key === "0" && !typing) {
      // Insert the original only — an explicit answer, distinct from Esc's abort.
      // Commits immediately: there is nothing left to choose.
      commit([]);
    } else if (/^[1-9]$/.test(e.key) && !typing) {
      const row = rows.find((r) => r.digit === Number(e.key));
      if (row) {
        setActive(rows.indexOf(row));
        toggle(row.code);
      }
    } else if (e.key === "Backspace" && query.length === 0 && chosen.length > 0) {
      setChosen((c) => c.slice(0, -1));
    } else {
      return; // let the field handle ordinary typing
    }
    e.preventDefault();
  }, [rows, active, chosen, query, commit, abort, toggle]);

  // Esc/Enter/digits must work from anywhere in the window, not only while the filter
  // field is focused: clicking a row moves focus to <body>, an ancestor of the React root,
  // so a keydown there never bubbled through the root div's handler — leaving an
  // undecorated always-on-top window with no way to answer or dismiss (QuickAdd hit the
  // same trap, and fixed it the same way).
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const src = safeDisplayText(seed.source ?? "", 12).toUpperCase() || "AUTO";
  const verb = seed.when === "after" ? "Insert" : "Start";

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden rounded-card border border-line-strong bg-panel"
      role="dialog"
      aria-label="Translate to"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="font-mono text-[10.5px] uppercase tracking-label text-faint">Translate to</span>
        <span className="ml-auto truncate font-mono text-[10.5px] uppercase tracking-label text-dim">
          {safeDisplayText(seed.tag ?? "", 24)}
          {seed.when === "after" ? " · ready to insert" : ""}
        </span>
      </div>

      {/* The route rail — the badge you are about to see on the chip, assembled live. */}
      <div className="flex min-h-[56px] flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="rounded-pill border border-line-strong bg-surface-2 px-2.5 py-1 font-mono text-[12px] text-text">
          {src}
        </span>
        <span className="font-mono text-faint" aria-hidden>
          →
        </span>
        {chosen.length === 0 ? (
          // The chip's own "undecided" glyph, so the two surfaces say the same thing.
          <>
            <span
              className="animate-chip-breathe rounded-pill border border-dashed border-line-strong px-2.5 py-1 font-mono text-[12px] text-faint"
              aria-hidden
            >
              ?
            </span>
            <span className="text-[12.5px] text-faint">pick, or 0 for the original</span>
          </>
        ) : (
          chosen.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              title={`Remove ${languageLabel(c)}`}
              className="ring-signal inline-flex items-center gap-1.5 rounded-pill border border-accent/50 px-2.5 py-1 font-mono text-[12px] text-accent"
            >
              {c.toUpperCase()}
              <span aria-hidden className="opacity-60">
                ×
              </span>
            </button>
          ))
        )}
      </div>

      <input
        key={showSeq}
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        placeholder="Filter languages…"
        aria-label="Filter languages"
        role="combobox"
        aria-expanded="true"
        aria-controls="langpick-list"
        aria-autocomplete="list"
        aria-activedescendant={rows[active] ? `langpick-opt-${active}` : undefined}
        className="w-full border-b border-line bg-transparent px-4 py-2.5 text-[13px] text-text outline-none placeholder:text-faint"
      />

      <ul id="langpick-list" ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-multiselectable="true">
        {rows.length === 0 && (
          <li role="presentation" className="px-3 py-6 text-center text-[12.5px] text-faint">
            No language matches “{safeDisplayText(query, 24)}”.
          </li>
        )}
        {groups.map((g) => (
          // role="group" owns its options for AT (an `option` must be a child of the listbox or
          // of a group inside it); the inner list is presentational.
          <li key={g.label} role="group" aria-label={g.label}>
            <div aria-hidden className="px-2.5 pb-1 pt-2 font-mono text-[9.5px] uppercase tracking-label text-faint">
              {g.label}
            </div>
            <ul role="presentation">
              {g.items.map((code) => {
                const i = rows.findIndex((r) => r.code === code);
                const on = chosen.includes(code);
                return (
                  <li
                    key={code}
                    id={`langpick-opt-${i}`}
                    data-row={i}
                    role="option"
                    aria-selected={on}
                    // Keep focus in the filter field: a click on the non-focusable row otherwise
                    // moved focus to <body>, so further typing was dropped and Space/digits
                    // flipped meaning for the same visible state.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setActive(i);
                      toggle(code);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px]",
                      i === active ? "bg-surface-2 text-text" : "text-dim",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-[18px] shrink-0 place-items-center rounded-md border font-mono text-[10.5px]",
                        on
                          ? "border-accent bg-accent text-accent-ink"
                          : "border-line-strong text-faint",
                      )}
                    >
                      {rows[i]?.digit ?? "·"}
                    </span>
                    <span className="truncate">{languageLabel(code)}</span>
                    <span
                      className={cn(
                        "ml-auto font-mono text-[11px]",
                        on ? "text-accent" : "text-faint",
                      )}
                    >
                      {code.toUpperCase()}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      {/* The three answers as real buttons (mouse users), each carrying the key that gives
          the same answer. The abort is red-tinted: it is the one that throws work away
          (hands-free: nothing starts; push-to-talk: the transcript is not inserted). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2.5 text-[11.5px] text-faint">
        <Hint k="1–9">pick</Hint>
        {chosen.length >= MAX_TARGETS && <span className="text-warn">max {MAX_TARGETS}</span>}
        <span className="flex-1" aria-hidden />
        <FooterButton tone="danger" k="esc" onClick={abort}>
          {seed.when === "after" ? "Don’t insert" : "Cancel"}
        </FooterButton>
        <FooterButton tone="neutral" k="0" onClick={() => commit([])}>
          {seed.when === "after" ? "Original" : "Original only"}
        </FooterButton>
        <FooterButton tone="primary" k="↵" onClick={() => commit(chosen)}>
          {verb}
        </FooterButton>
      </div>
    </div>
  );
}

/** One of the footer's three answers. `onMouseDown` swallows the press so focus stays in the
 *  filter field: a click that moved focus to the button would drop the next typed digit
 *  (the window-level keydown still fires, but the field no longer receives the text). */
function FooterButton({
  tone,
  k,
  onClick,
  children,
}: {
  tone: "danger" | "neutral" | "primary";
  k: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "ring-signal inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-[12px] font-medium",
        tone === "danger" && "border-rec/45 text-rec",
        tone === "neutral" && "border-line-strong text-dim",
        tone === "primary" && "border-accent bg-accent font-semibold text-accent-ink",
      )}
    >
      {children}
      <span className="font-mono text-[10px] opacity-70" aria-hidden>
        {k}
      </span>
    </button>
  );
}

function Hint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-dim">
        {k}
      </kbd>
      {children}
    </span>
  );
}
