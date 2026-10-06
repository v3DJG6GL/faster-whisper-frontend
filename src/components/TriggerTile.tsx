// The trigger tile: how a profile (or quick add) is started from any app — its shortcut and, for
// dictation, whether the keys are held or pressed twice — as one bordered object. Design "Shortcut
// Field" (D80 B, D81 K1, D82 R1). Shared by every rebind surface: the Profiles editor, the
// onboarding starters, and QuickAddShortcutField (Dictionary + onboarding quick-add step).
//
// Presentation only: the capture logic (held-modifier tracking, validation, clash detection,
// suspend/reregister) lives in useHotkeyCapture, which the parent drives and passes in as `capture`.
//
// The tile says in a sentence what the keys do ("Hold Ctrl + Shift while you speak…"), so the
// activation switch is never read apart from the keys it changes. States of the key strip:
// bound, recording (live keycaps + "Press the keys · Esc cancels"), taken by another binding
// ("Use it here" / "Try again"), and empty. Clearing is the × button — Backspace stays a key.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button, Segmented } from "@/components/ui";
import { codesToLabels } from "@/lib/keys";
import { cn } from "@/lib/cn";
import type { PendingChord } from "@/lib/useHotkeyCapture";
import type { ActivationKind } from "@/lib/types";

const KEY_SPRING = { type: "spring", stiffness: 520, damping: 30, mass: 0.7 } as const;

/** A shortcut key as a pressable keycap (the small `Kbd` stays for lists and hints). While a
 *  shortcut is being recorded, a held key sits pressed down: shifted by its lower edge, which
 *  shrinks to a line — the keycap you are holding looks held. */
function KeyCap({ children, held }: { children: string; held?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-9 min-w-9 items-center justify-center rounded-[9px] border bg-key px-2.5 font-mono text-[13.5px] font-medium text-text transition-[transform,border-width,border-color] duration-100",
        held ? "translate-y-[2px] border-b border-accent" : "border-b-[3px] border-line-strong",
        "border-b-[color:var(--c-key-edge)]",
      )}
    >
      {children}
    </kbd>
  );
}

/** The keys of a chord. Each key springs in as it arrives (pressed during recording, or the
 *  saved chord settling in one after another after `settleKey` changes); released keys fade. */
function KeyRow({
  codes,
  held,
  trailing,
  settleKey,
}: {
  codes: string[];
  held?: boolean;
  trailing?: boolean;
  /** Bumped when a new shortcut is saved: replays the staggered settle. */
  settleKey?: number;
}) {
  const reduce = useReducedMotion();
  const labels = codesToLabels(codes);
  const enter = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, scale: 0.7, y: -6 },
          animate: { opacity: 1, scale: 1, y: 0, transition: { ...KEY_SPRING, delay: held ? 0 : i * 0.06 } },
          exit: { opacity: 0, scale: 0.85, transition: { duration: 0.12 } },
        };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <AnimatePresence initial={false} mode="popLayout">
        {labels.map((k, i) => (
          <motion.span
            key={`${settleKey ?? 0}:${codes[i]}`}
            layout={!reduce}
            className="inline-flex items-center gap-1.5"
            {...enter(i)}
          >
            {i > 0 && <span className="font-mono text-[13px] text-faint">+</span>}
            <KeyCap held={held}>{k}</KeyCap>
          </motion.span>
        ))}
        {trailing && (
          <motion.span key="next" layout={!reduce} className="inline-flex items-center gap-1.5">
            {labels.length > 0 && <span className="font-mono text-[13px] text-faint">+</span>}
            <span className="inline-flex h-9 min-w-9 animate-pulse items-center justify-center rounded-[9px] border border-dashed border-line-strong font-mono text-faint motion-reduce:animate-none">
              …
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** True for a moment after `codes` changed while not recording — a new shortcut was just saved. */
function useJustSet(codes: string[], capturing: boolean): [boolean, number] {
  const sig = codes.join("+");
  const prev = useRef(sig);
  const [n, setN] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (sig === prev.current) return;
    prev.current = sig;
    if (capturing || sig === "") return;
    setN((x) => x + 1);
    setOn(true);
    const t = window.setTimeout(() => setOn(false), 900);
    // A re-run (Clear, or Change starting a recording) cancels the timer, so it drops the ring too.
    return () => {
      window.clearTimeout(t);
      setOn(false);
    };
  }, [sig, capturing]);
  return [on, n];
}

/** "Ctrl + Alt + Num +" — the keys as one phrase for the sentence and screen readers. */
function chordPhrase(codes: string[]): string {
  return codesToLabels(codes).join(" + ");
}

export type TriggerPurpose = "dictation" | "quickadd";

export function TriggerTile({
  title = "Trigger",
  purpose,
  codes,
  capturing,
  capture,
  activation,
  onActivationChange,
  onToggle,
  onRetry,
  onClear,
}: {
  title?: string;
  /** Dictation profiles show the Push-to-talk / Hands-free switch and say how the keys behave;
   *  quick add is a single press. */
  purpose: TriggerPurpose;
  /** The bound chord (event.code list); [] when unset. */
  codes: string[];
  capturing: boolean;
  /** Live state from useHotkeyCapture. */
  capture: {
    heldCodes: string[];
    warn: string | null;
    pending: PendingChord | null;
    acceptPending: () => void;
    dismissPending: () => void;
  };
  activation?: ActivationKind;
  onActivationChange?: (v: ActivationKind) => void;
  /** Start / cancel recording. */
  onToggle: () => void;
  /** "Try again" after a clash: drop the clash and record anew. */
  onRetry: () => void;
  /** Clear the binding. Omit to hide the × (a starter profile always keeps a shortcut). */
  onClear?: () => void;
}) {
  const { heldCodes, warn, pending } = capture;
  const phrase = chordPhrase(codes);
  const [justSet, settleKey] = useJustSet(codes, capturing);
  const reduce = useReducedMotion();
  const mode = activation === "handsfree" ? "handsfree" : "hold";

  let sentence: ReactNode;
  if (codes.length === 0) {
    sentence =
      purpose === "quickadd"
        ? "No shortcut yet. Record one to open quick add over any app."
        : "No shortcut yet. Record one to start this profile from any app.";
  } else if (purpose === "quickadd") {
    sentence = (
      <>
        Press <b className="font-semibold text-text">{phrase}</b> over any app to map a misheard word onto the
        pinned list.
      </>
    );
  } else if (mode === "hold") {
    sentence = (
      <>
        Hold <b className="font-semibold text-text">{phrase}</b> while you speak, let go to stop.
      </>
    );
  } else {
    sentence = (
      <>
        Press <b className="font-semibold text-text">{phrase}</b> to start dictating, press it again to stop.
      </>
    );
  }

  // What a screen reader hears when the strip changes (recording, clash, warning).
  const status = capturing
    ? (warn ?? "Recording a shortcut. Press the keys, Escape cancels.")
    : pending
      ? clashText(pending)
      : "";

  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-card border border-line-strong bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="font-display text-[15px] font-[650]">{title}</span>
        {purpose === "dictation" && onActivationChange && (
          <Segmented
            value={mode}
            onChange={(v) => onActivationChange(v)}
            ariaLabel="Activation"
            options={[
              { value: "hold", label: "Push-to-talk" },
              { value: "handsfree", label: "Hands-free" },
            ]}
          />
        )}
      </div>

      <div
        className={cn(
          "flex min-h-[60px] flex-wrap items-center gap-2.5 rounded-xl border bg-surface-2 p-3 transition-[border-color,box-shadow] duration-300",
          capturing || justSet
            ? "border-accent ring-[3px] ring-accent/20"
            : pending
              ? "border-warn"
              : codes.length === 0
                ? "border-dashed border-line-strong"
                : "border-line",
        )}
      >
        {capturing ? (
          <>
            <span className="mx-1 size-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
            <span className="min-w-0 flex-1">
              <KeyRow codes={heldCodes} held trailing />
            </span>
            <span className={cn("text-[12px]", warn ? "text-rec" : "text-dim")}>
              {warn ?? "Press the keys · Esc cancels"}
            </span>
            <Button variant="ghost" size="sm" onClick={onToggle}>
              Cancel
            </Button>
          </>
        ) : pending ? (
          <>
            <span className="min-w-0 flex-1">
              <KeyRow codes={pending.codes} />
            </span>
            <Button size="sm" onClick={capture.acceptPending}>
              Use it here
            </Button>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : codes.length === 0 ? (
          <>
            <span className="min-w-0 flex-1 pl-1 text-[13px] text-dim">No shortcut</span>
            <button
              type="button"
              onClick={onToggle}
              className="ring-signal inline-flex h-8 items-center rounded-xl border border-accent px-3 text-[12px] font-medium text-accent hover:bg-accent-soft"
            >
              Record shortcut
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1" aria-label={`Shortcut: ${phrase}`}>
              <KeyRow codes={codes} settleKey={settleKey} />
            </span>
            <Button size="sm" onClick={onToggle}>
              Change
            </Button>
            {onClear && (
              <button
                type="button"
                aria-label="Clear shortcut"
                title="Clear shortcut"
                onClick={onClear}
                className="ring-signal inline-flex size-8 items-center justify-center rounded-lg text-dim hover:bg-surface hover:text-text"
              >
                <X className="size-4" />
              </button>
            )}
          </>
        )}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={pending ? "clash" : `${mode}:${phrase}`}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: reduce ? 0 : 0.16 }}
          className={cn("text-[13px]", pending ? "text-warn" : "text-dim")}
        >
          {pending ? clashText(pending) : sentence}
        </motion.p>
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {status}
      </span>
    </section>
  );
}

function clashText(p: PendingChord): string {
  const keys = chordPhrase(p.codes);
  return p.kind === "duplicate"
    ? `“${p.otherName}” already uses ${keys}. Use it here and “${p.otherName}” loses its shortcut.`
    : `${keys} overlaps the shortcut of “${p.otherName}”, so one would set off the other. Use it here and “${p.otherName}” loses its shortcut.`;
}
