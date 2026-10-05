import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { routeParts } from "@/lib/routeParts";

/* ── Badge ────────────────────────────────────────────────────────────── */
// The pill's shape, shared with RouteBadge below. Exported as a STRING rather than
// widening Badge with a className/tone: Badge has neither by design, it is used on
// nearly every screen, and a per-site escape hatch on it would be the end of that.
// `max-w-[16ch]` + `truncate`: badges carry remote-authored leaves (a backend's
// language, a profile's tag) whose sanitizers bound the LIST length, not the per-field
// length — and `languageLabel` returns an unknown code unchanged. Unbounded here, one
// field pushed the Test/Edit/Remove controls off the card it labels.
const BADGE_BASE =
  "inline-block align-bottom rounded-md px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider truncate";

/** A small uppercase pill. `accent` = highlighted, `warn` = caution, default = dim. */
export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "dim" | "warn" }) {
  return (
    <span
      className={cn(
        BADGE_BASE, "max-w-[16ch]",
        tone === "accent"
          ? "bg-accent-soft text-accent"
          : tone === "warn"
            ? "bg-warn/10 text-warn"
            : "bg-surface-2 text-dim",
      )}
    >
      {children}
    </span>
  );
}

/* ── LangTag ──────────────────────────────────────────────────────────── */

/** Leading language tag on a track line (original neutral; MT takes the
 *  line's resolved color — dimmed speaker accent, or an accent-mixed fallback:
 *  teal belongs to the translating STAGE, not to translated text).
 *
 *  Lives here rather than in the viewer because History renders the same
 *  per-language tracks and the two must not drift: a track's code has to
 *  look identical whether you are reading a transcript or a dictation. */
export function LangTag({ code, orig, color }: { code: string; orig?: boolean; color?: string }) {
  // No speaker colour: the accent pulled 35% toward --c-faint, so the tag is
  // recognisably "ours" without competing with a selected chip.
  const mt = color ?? "color-mix(in srgb, var(--c-accent) 65%, var(--c-faint))";
  return (
    <span
      className={cn(
        "mr-1.5 inline-block translate-y-[-1px] rounded border px-1 font-mono text-[9.5px] uppercase tracking-wider",
        orig && "border-line-strong text-dim",
      )}
      style={
        !orig
          ? {
              color: mt,
              // A 40%-alpha border is fine to mix toward transparent — the
              // WebKitGTK gradient caveat only bites large text/fill areas.
              borderColor: `color-mix(in srgb, ${mt} 40%, transparent)`,
            }
          : undefined
      }
    >
      {code}
    </span>
  );
}

/* ── RouteBadge ───────────────────────────────────────────────────────── */
/** The dictation ROUTE as one badge: the spoken language, and — when the profile
 *  translates — the languages its output is turned into. With no targets it renders
 *  exactly the plain language badge it replaced, so a profile without translation
 *  looks unchanged. */
export function RouteBadge({ source, targets }: { source: string; targets?: string[] | null }) {
  const r = routeParts(source, targets);
  if (!r.source && r.targets.length === 0) return null;
  return (
    // max-w is raised over BADGE_BASE's 16ch because this pill legitimately holds a
    // route, not a single leaf — each PART is bounded by routeParts instead.
    <span className={cn(BADGE_BASE, "max-w-[34ch] bg-surface-2")}>
      <span className="text-dim">{r.source || "auto"}</span>
      {r.targets.length > 0 && (
        <>
          <span className="px-1 text-faint" aria-hidden>
            →
          </span>
          <span className="text-accent">{r.targets.join(", ")}</span>
          {r.more > 0 && <span className="pl-1 text-faint">+{r.more}</span>}
        </>
      )}
    </span>
  );
}

/* ── Notice ───────────────────────────────────────────────────────────── */
/** An inline status banner: a tinted, rounded box with a leading icon and content.
 *  `warn` (default) = caution amber + AlertTriangle; `ok` = success + Check. Pass
 *  `className` for per-site spacing (e.g. `mt-3`). Single-sources the inline banner
 *  that recurred across the Backends / Transcribe / Dictionary / Home screens. */
export function Notice({
  tone = "warn",
  className,
  children,
}: {
  /** "note" is the quiet one: something worth knowing that is not a problem (the neutral
   *  panel of `SettingExpand`, not a semantic colour). */
  tone?: "warn" | "ok" | "note";
  className?: string;
  children: ReactNode;
}) {
  const Icon = tone === "ok" ? Check : tone === "note" ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
        tone === "ok"
          ? "border-ok/30 bg-ok/5 text-ok"
          : tone === "note"
            ? "border-line bg-surface-2/40 text-dim"
            : "border-warn/30 bg-warn/5 text-warn",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/* ── Toast (transient, with optional action) ──────────────────────────── */

/** A bottom-center transient notice with an optional action ("Undo"). Portaled
 *  to <body>: Card's backdrop-blur makes it a containing block for fixed
 *  descendants (same reason the Sync modal portals). The caller owns the
 *  timeout — render while its state says so. */
export function Toast({
  children,
  actionLabel,
  onAction,
  onDismiss,
  durationMs = 8000,
}: {
  children: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  /** Auto-dismiss delay; 0 disables (sticky toast). */
  durationMs?: number;
}) {
  useEffect(() => {
    if (!durationMs) return;
    const t = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(t);
    // Re-arm when the message changes so a second reset gets its full window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children, durationMs]);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-xl border border-line-strong bg-panel px-4 py-2.5 text-[12.5px] text-text shadow-lg"
      >
        <span>{children}</span>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="ring-signal font-semibold text-accent hover:underline"
          >
            {actionLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="ring-signal rounded-md p-0.5 text-faint hover:text-text"
        >
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ── Status dot ───────────────────────────────────────────────────────── */
const DOT_BG: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  rec: "bg-rec",
  idle: "bg-faint",
  faint: "bg-faint",
  accent: "bg-accent",
  armed: "bg-armed",
  live: "bg-live",
  dim: "bg-dim",
  think: "bg-think",
  translate: "bg-translate",
};
/** A small state dot. The dictation surfaces drive `tone`/`filled`/`pulse` from
 *  `dictationVisual()` so colour + shape + motion all match the overlay chip; off
 *  renders HOLLOW (the hue-independent cue). The generic `ok/warn/rec` tones stay
 *  for non-dictation uses (e.g. the backend-connection dot). */
export function StatusDot({
  tone = "ok",
  pulse,
  filled = true,
  title,
}: {
  // The dictation half of this union IS DictationTone — the sidebar hands `vis.tone`
  // straight through, so a tone added there must exist here (and in DOT_BG) or the dot
  // renders unstyled.
  tone?: "ok" | "warn" | "rec" | "idle" | "faint" | "accent" | "armed" | "live" | "dim" | "think" | "translate";
  pulse?: boolean;
  filled?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block size-2 rounded-full",
        filled ? DOT_BG[tone] : "border border-faint bg-transparent",
        pulse && "animate-rec-pulse",
      )}
    />
  );
}
