// The per-session translation-target picker (Tauri window label `langpick`).
//
// Asks which languages THIS dictation should be turned into, then answers and closes.
// Like Overlay.tsx and QuickAdd.tsx this is a STANDALONE root with its own JS context and
// no store — everything it needs arrives in the `langpick://shown` seed, and its answer
// goes back over `langpick://commit`.
//
// Not a command palette. The fast path is a NUMBERED quick-pick: the first nine rows (Recent,
// then the model's languages) keep a stable digit, the profile's own targets are preselected,
// and the whole decision is "2 3 Enter" without looking. Typing still filters, for the long
// tail; Enter on a filtered row picks it and clears the filter. Rows, groups, search and
// movement are the main window's target picker's (lib/languages, lib/listNav, OptionRows).
//
// The rail across the top assembles the same `source → targets` route the chip will show a
// second later — same arrow, same accent — so the picker teaches the chip rather than
// introducing a second vocabulary for one idea. (The accent, not the translate teal: teal is
// the chip's translating STAGE, work in progress; a chosen target is a promise, and the chip
// shows its resolved route in the accent too.)
//
// Three answers, and only three: Enter commits the chosen targets (or, while a filter is
// typed, picks the highlighted row), `0` commits none (insert
// the original only), and Esc / Cancel / a closed window ABORT the whole action — no session
// starts (hands-free), or the finished transcript is not inserted (push-to-talk; it still
// goes to History). There is no "dismiss and quietly use the Profile's preset": every way
// out of this window is a decision the user can see.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abortLangPick, commitLangPick, isTauri } from "@/lib/api";
import { langCode, targetSections, toggleCode, type LangRow } from "@/lib/languages";
import { navKey } from "@/lib/listNav";
import { cleanRecent } from "@/lib/recent";
import { KeyHint, OptionRows, optionId } from "@/components/ListPicker";
import { CodeChip } from "@/components/ui";
import { TargetRow, untestedTitle } from "@/components/LanguagePicker";
import { applyAccentAndTheme, startAccentDrift, watchSystemTheme } from "@/lib/theme";
import { safeDisplayText } from "@/lib/sanitize";
import { cn } from "@/lib/cn";
import type { AccentMotion, ThemeName } from "@/lib/types";

/** Mirrors TRANSLATION_MAX_TARGETS — the server translates every context segment once per
 *  target, so the cost is linear in this number and the cap is a real one. */
const MAX_TARGETS = 8;
const LIST_ID = "langpick-list";

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
  /** The session's translation model's languages; null/absent = unknown (all, untagged). */
  supported?: string[] | null;
  /** That model's short name, for the "Supported by …" group. */
  modelName?: string;
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
          applyAccentAndTheme(typeof s.accentHue === "number" ? s.accentHue : undefined, s.accentMotion, s.theme ?? "auto");
          // Preselect the Profile's own targets: Enter with no keystrokes must reproduce
          // what would have happened without the picker. Anything else makes the prompt a
          // trap — confirming it by habit would silently change the outcome. (Esc is the
          // other habit, and it aborts loudly rather than changing anything.)
          setChosen([...new Set(
            (s.preset ?? []).filter((t) => typeof t === "string" && t.length <= 64),
          )].slice(0, MAX_TARGETS));
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
  useEffect(() => {
    document.getElementById(optionId(LIST_ID, active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Recent, then the model's languages, then the rest — never the spoken language (translating
  // a language into itself is a no-op that would still cost a server round-trip per phrase).
  // Grouped rather than merged: a flat list ranked by recency reorders under the user between
  // summons, and a numbered pick is only fast if the number is where it was last time. The
  // seed is untrusted shape, so every list is cleaned first.
  const groups = useMemo(
    () =>
      targetSections({
        query,
        recent: cleanRecent(seed.recent),
        supported: Array.isArray(seed.supported) ? cleanRecent(seed.supported, 500) : null,
        modelName: typeof seed.modelName === "string" ? safeDisplayText(seed.modelName, 40) : undefined,
        exclude: seed.source,
      }),
    [seed.recent, seed.supported, seed.modelName, seed.source, query],
  );

  // Flattened, in DISPLAY order: row i answers to digit i + 1 (1–9), so what you see and what
  // you press can't disagree.
  const rows = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.value)), [groups]);

  const toggle = useCallback((code: string) => setChosen((cur) => toggleCode(cur, code, MAX_TARGETS)), []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const typing = document.activeElement === inputRef.current && query.length > 0;
    const nav = navKey(e.key, active, rows.length);
    if (e.key === "Escape") {
      // Abort the whole action (don't start / don't insert) — see the header comment.
      abort();
    } else if (e.key === "Enter") {
      if (typing) {
        // A live filter means the user is hunting for a row, not confirming the
        // preset: pick it and clear the filter so the NEXT Enter commits. No match
        // (a mistyped filter) is a no-op — committing the preset here would be the
        // very habit trap the footer hint says this key avoids.
        const code = rows[active];
        if (code) {
          toggle(code);
          setQuery("");
          setActive(0);
        }
      } else {
        commit(chosen);
      }
    } else if (nav !== null) {
      setActive(nav);
    } else if (e.key === " " && !typing) {
      if (rows[active]) toggle(rows[active]);
    } else if (e.key === "0" && !typing) {
      // Insert the original only — an explicit answer, distinct from Esc's abort.
      // Commits immediately: there is nothing left to choose.
      commit([]);
    } else if (/^[1-9]$/.test(e.key) && !typing) {
      const i = Number(e.key) - 1;
      if (rows[i]) {
        setActive(i);
        toggle(rows[i]);
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

  const src = langCode(seed.source ?? "", 12) || "AUTO";
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
            <CodeChip key={c} code={c} size="md" onRemove={() => toggle(c)} />
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
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={rows[active] ? optionId(LIST_ID, active) : undefined}
        className="w-full border-b border-line bg-transparent px-4 py-2.5 text-[13px] text-text outline-none placeholder:text-faint"
      />

      <OptionRows<LangRow>
        id={LIST_ID}
        label="Translate to"
        multi
        sections={groups}
        active={active}
        rowKey={(r) => r.value}
        isSelected={(r) => chosen.includes(r.value)}
        onPick={(r, i) => {
          setActive(i);
          toggle(r.value);
        }}
        renderRow={(r, { selected, index }) => <TargetRow row={r} on={selected} mark={index < 9 ? index + 1 : "·"} />}
        rowTitle={untestedTitle}
        empty={
          <div className="px-3 py-6 text-center text-[12.5px] text-faint">
            No language matches “{safeDisplayText(query, 24)}”.
          </div>
        }
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      />

      {/* The three answers as real buttons (mouse users), each carrying the key that gives
          the same answer. The abort is red-tinted: it is the one that throws work away
          (hands-free: nothing starts; push-to-talk: the transcript is not inserted). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2.5 text-[11.5px] text-faint">
        <KeyHint k="1–9">pick</KeyHint>
        {query.length > 0 && <KeyHint k="↵">pick filtered</KeyHint>}
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
