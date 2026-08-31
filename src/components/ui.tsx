import {
  type ReactNode,
  type ReactElement,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Check, Minus, MoreHorizontal, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { languageLabel } from "@/lib/languages";
import { safeDisplayText } from "@/lib/sanitize";

/* ── Card ─────────────────────────────────────────────────────────────── */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative rounded-card border border-line bg-surface/80 backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Section heading ──────────────────────────────────────────────────── */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "font-mono text-[11px] uppercase tracking-label text-faint flex items-center gap-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Page header ──────────────────────────────────────────────────────── */
/** The eyebrow + title + lede triple at the top of a screen. Renders a fragment so it
 *  drops into either a bare container or the inner div of a flex header row unchanged. */
export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <>
      <div className="font-mono text-[11px] uppercase tracking-label text-accent">{eyebrow}</div>
      <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">{title}</h1>
      <p className="mt-2 max-w-md text-[13.5px] text-dim">{children}</p>
    </>
  );
}

/* ── ListScreenHeader ─────────────────────────────────────────────────── */
/**
 * The header row shared by the list screens (Backends / Profiles / Per-app rules):
 * a {@link PageHeader} on the left and an optional accent "Add …" button on the right.
 */
export function ListScreenHeader({
  eyebrow,
  title,
  children,
  showAdd,
  addLabel,
  onAdd,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  showAdd: boolean;
  addLabel: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <PageHeader eyebrow={eyebrow} title={title}>
          {children}
        </PageHeader>
      </div>
      {showAdd && (
        <Button variant="accent" onClick={onAdd}>
          <Plus className="size-4" /> {addLabel}
        </Button>
      )}
    </div>
  );
}

/* ── EditorHeader ─────────────────────────────────────────────────────── */
/**
 * The header of a full-page editor (Profiles / Backends / Per-app rules), where
 * the editor REPLACES the list it came from.
 *
 * It pins to the top of the scroll container, because that is the whole point:
 * these forms run past a screen height, and the only way out used to be a
 * Cancel button below the fold. It also names what you're editing — the page
 * header behind it keeps saying "Profiles", which is a lie once the editor is
 * open — and shows whether there is unsaved work.
 *
 * The bottom Save/Cancel pair stays: that's where a form finishes. This adds a
 * way out from the top, it doesn't move the finish line.
 */
export function EditorHeader({
  onBack,
  title,
  subtitle,
  dirty,
  saveLabel,
  onSave,
  saveDisabled,
}: {
  onBack: () => void;
  title: string;
  subtitle?: ReactNode;
  dirty?: boolean;
  saveLabel: string;
  onSave: () => void;
  saveDisabled?: boolean;
}) {
  return (
    <div className="sticky top-0 z-20 -mx-6 -mt-6 mb-5 flex items-center gap-3 rounded-t-card border-b border-line bg-surface/95 px-6 py-3 backdrop-blur-sm">
      <button
        type="button"
        onClick={onBack}
        title="Back — Esc"
        aria-label="Back"
        className="ring-signal -ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-surface-2 hover:text-text"
      >
        <ArrowLeft className="size-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-text">{title}</div>
        {subtitle && <div className="truncate text-[11.5px] text-faint">{subtitle}</div>}
      </div>
      {dirty && (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-label text-warn">
          <span className="size-1.5 rounded-full bg-warn" aria-hidden />
          unsaved
        </span>
      )}
      <Button variant="accent" size="sm" onClick={onSave} disabled={saveDisabled}>
        {saveLabel}
      </Button>
    </div>
  );
}

/* ── ConfirmLeave ─────────────────────────────────────────────────────── */
/**
 * The prompt an editor raises when you try to leave with unsaved changes.
 * Three named outcomes rather than "Are you sure?" — every button says what it
 * does to the work.
 */
export function ConfirmLeave({
  what,
  onSaveAndLeave,
  onDiscard,
  onStay,
}: {
  /** What is being edited, e.g. "profile" — used in the sentence. */
  what: string;
  onSaveAndLeave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  // Esc keeps you here: the destructive answer is never the reflex one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onStay();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onStay]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onStay}
      role="dialog"
      aria-modal="true"
      aria-label="Unsaved changes"
    >
      <div className="w-full max-w-[420px]" onClick={(e) => e.stopPropagation()}>
        <Card className="px-6 py-5">
          <div className="text-[14px] font-semibold text-text">
            This {what} has unsaved changes
          </div>
          <p className="mt-1.5 text-[13px] text-dim">
            Leaving now keeps the {what} as it was before you started editing.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onStay}>
              Keep editing
            </Button>
            <Button variant="ghost" size="sm" onClick={onDiscard}>
              Discard changes
            </Button>
            <Button variant="accent" size="sm" onClick={onSaveAndLeave}>
              Save and leave
            </Button>
          </div>
        </Card>
      </div>
    </div>,
    document.body,
  );
}

/* ── Badge ────────────────────────────────────────────────────────────── */
// The pill's shape, shared with RouteBadge below. Exported as a STRING rather than
// widening Badge with a className/tone: Badge has neither by design, it is used on
// nearly every screen, and a per-site escape hatch on it would be the end of that.
// `max-w` + `truncate`: badges carry remote-authored leaves (a backend's language, a
// profile's tag) whose sanitizers bound the LIST length, not the per-field length — and
// `languageLabel` returns an unknown code unchanged. Unbounded here, one field pushed
// the Test/Edit/Remove controls off the card it labels.
export const BADGE_BASE =
  "inline-block max-w-[16ch] truncate align-bottom rounded-md px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider";

/** A small uppercase pill. `accent` = highlighted, `warn` = caution, default = dim. */
export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "dim" | "warn" }) {
  return (
    <span
      className={cn(
        BADGE_BASE,
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
 *  line's resolved color — dimmed speaker accent, or teal fallback).
 *
 *  Lives here rather than in the viewer because History renders the same
 *  per-language tracks and the two must not drift: a track's code has to
 *  look identical whether you are reading a transcript or a dictation. */
export function LangTag({ code, orig, color }: { code: string; orig?: boolean; color?: string }) {
  return (
    <span
      className={cn(
        "mr-1.5 inline-block translate-y-[-1px] rounded border px-1 font-mono text-[9.5px] uppercase tracking-wider",
        orig
          ? "border-line-strong text-dim"
          : !color && "border-[color:var(--c-translate)]/40 text-[color:var(--c-translate)]",
      )}
      style={
        !orig && color
          ? {
              color,
              // A 40%-alpha border is fine to mix toward transparent — the
              // WebKitGTK gradient caveat only bites large text/fill areas.
              borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
            }
          : undefined
      }
    >
      {code}
    </span>
  );
}

/* ── RouteBadge ───────────────────────────────────────────────────────── */
// How many targets are spelled out before the rest become "+N". Three is what fits
// beside a profile's name, model and endpoint badges without wrapping the row.
const ROUTE_TARGETS_SHOWN = 3;

/** The pieces of a `source → targets` route, bounded for display.
 *
 *  Pure + exported so it can be tested: every part is user- or peer-authored (a
 *  profile's language, a synced backend's, the translate-to list), and
 *  `languageLabel` passes an unknown code through unchanged — the same unbounded-leaf
 *  hazard the badge's own truncate exists for, except a LIST of them multiplies it. */
export function routeParts(
  source: string,
  targets?: string[] | null,
): { source: string; targets: string[]; more: number } {
  const labels = (targets ?? [])
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .map((t) => safeDisplayText(languageLabel(t), 24));
  return {
    source: safeDisplayText(source, 24),
    targets: labels.slice(0, ROUTE_TARGETS_SHOWN),
    more: Math.max(0, labels.length - ROUTE_TARGETS_SHOWN),
  };
}

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
          <span className="text-translate">{r.targets.join(", ")}</span>
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
  tone?: "warn" | "ok";
  className?: string;
  children: ReactNode;
}) {
  const Icon = tone === "ok" ? Check : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
        tone === "ok" ? "border-ok/30 bg-ok/5 text-ok" : "border-warn/30 bg-warn/5 text-warn",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** A text "›" disclosure toggle that rotates 90° when open (used to reveal advanced/override
 *  sections). The chevron + base button styling are single-sourced; pass `className` for per-site
 *  spacing (e.g. mt-4) and `children` for the label (and any trailing "· set" suffix). */
export function DisclosureToggle({
  open,
  onToggle,
  className,
  children,
  ariaControls,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
  /** id of the panel this toggle expands (aria-controls). */
  ariaControls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={ariaControls}
      className={cn(
        "ring-signal inline-flex items-center gap-1.5 rounded-lg text-[12.5px] font-medium text-dim hover:text-text",
        className,
      )}
    >
      <span className={cn("transition-transform", open && "rotate-90")}>›</span>
      {children}
    </button>
  );
}

/** A disclosure whose HEADER LIVES INSIDE THE BOX: collapsed it is a slim
 *  tinted strip, expanding grows the same framed panel. Replaces the older
 *  "floating toggle above a card" pattern, which left the label stranded on
 *  the page background. `nested` renders the sub-panel scale (one surface
 *  step up, tighter padding) for a disclosure inside another panel. */
export function DisclosureCard({
  open,
  onToggle,
  title,
  nested,
  className,
  bodyClassName,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** Header content — the label plus any "· 2 set" style suffixes. */
  title: ReactNode;
  nested?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div
      className={cn(
        "overflow-hidden border border-line",
        nested ? "rounded-xl" : "rounded-card bg-surface/80",
        className,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "ring-signal flex w-full items-center gap-2 text-left font-medium text-dim hover:text-text",
          nested ? "bg-surface-2/70 px-3.5 py-2.5 text-[12px]" : "bg-surface-2/60 px-4 py-3 text-[12.5px]",
          open && "border-b border-line",
        )}
      >
        <span className={cn("transition-transform", open && "rotate-90")}>›</span>
        <span className="min-w-0 flex-1">{title}</span>
      </button>
      {open && (
        <div id={panelId} className={cn(nested ? "p-3.5" : "p-5", bodyClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Row overflow menu (⋯) ────────────────────────────────────────────── */

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A small "⋯" popover menu for row/group-level secondary actions (reset
 *  tiers on the Sync list). Absolute dropdown inside its own relative
 *  wrapper; Escape and click-away close it. */
export function RowMenu({ items, ariaLabel }: { items: RowMenuItem[]; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="ring-signal grid size-7 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-text"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 min-w-[200px] rounded-xl border border-line-strong bg-panel p-1 shadow-lg"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                "ring-signal block w-full rounded-lg px-3 py-1.5 text-left text-[12.5px] font-medium",
                it.danger ? "text-rec hover:bg-rec/10" : "text-dim hover:bg-surface-2 hover:text-text",
                it.disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
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

/** A form field with a small dim label above its control. */
export function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  // Like SettingRow, the caption is a sibling <label> with no htmlFor (and doesn't wrap the child),
  // so a direct Select/TextInput child has NO accessible name — a screen reader announces only
  // "combobox" + value. Auto-label it from `label` unless one is already set. Select takes an
  // `ariaLabel` prop; TextInput forwards native `aria-label`. Composite children (e.g. an API-key
  // input + reveal button wrapped in a div) fail the type check and pass through untouched.
  let control: ReactNode = children;
  if (isValidElement(children)) {
    if (children.type === Select) {
      control = cloneElement(children as ReactElement<{ ariaLabel?: string }>, {
        ariaLabel: (children.props as { ariaLabel?: string }).ariaLabel ?? label,
      });
    } else if (children.type === TextInput) {
      control = cloneElement(children as ReactElement<{ "aria-label"?: string }>, {
        "aria-label": (children.props as { "aria-label"?: string })["aria-label"] ?? label,
      });
    }
  }
  return (
    <div className={className}>
      <label className="mb-2 block text-[12px] font-medium text-dim">{label}</label>
      {control}
    </div>
  );
}

/* ── Toggle (pill switch) ─────────────────────────────────────────────── */
export function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  /** `"mixed"` renders the tri-state look (centered accent knob) used by
   *  group master switches; the parent computes the click semantics
   *  (mixed → all-on → all-off) — `onChange` still receives a boolean. */
  checked: boolean | "mixed";
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const mixed = checked === "mixed";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? "mixed" : checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(mixed ? true : !checked)}
      className={cn(
        "ring-signal relative h-[26px] w-[46px] shrink-0 rounded-pill border transition-colors duration-200",
        checked === true
          ? "border-accent bg-accent"
          : mixed
            ? "border-accent bg-accent-soft"
            : "border-line-strong bg-surface-2",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-all duration-200",
          checked === true
            ? "left-[23px] bg-accent-ink"
            : mixed
              ? "left-[13px] bg-accent"
              : "left-[3px] bg-faint",
        )}
      />
    </button>
  );
}

/* ── Segmented control ────────────────────────────────────────────────── */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div
      // Name the group so a screen reader can tell otherwise-identical Inherit/On/Off triplets apart
      // (e.g. the decode-override bools). Harmless when omitted — no name, same as before.
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex rounded-pill border border-line bg-surface-2 p-[3px]",
        disabled && "opacity-40",
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            // Single-select state for screen readers (mirrors Toggle's role=switch and the Dictionary
            // pin's aria-pressed) — otherwise the active option reads as just another plain button.
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              // Labels are short by design and read as one token ("Clipboard paste"):
              // wrapping one across two lines makes the group look broken.
              "ring-signal whitespace-nowrap rounded-pill px-3.5 py-1 text-[13px] font-medium transition-colors",
              active ? "bg-accent text-accent-ink" : "text-dim hover:text-text",
              disabled && "cursor-not-allowed hover:text-dim",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Inputs ───────────────────────────────────────────────────────────── */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "ring-signal h-10 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[13px] text-text",
          "placeholder:text-faint",
          className,
        )}
        {...props}
      />
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "ring-signal w-full resize-none rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-text",
          "placeholder:text-faint",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  disabled,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          "ring-signal h-10 w-full appearance-none rounded-xl border border-line bg-surface-2 pl-3.5 pr-9 text-[13px] text-text",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ── Stepper (numeric spinner) ────────────────────────────────────────── */
/** A −/+ numeric field for granular timeout-style settings. The value is typeable
 *  (clamped to [min,max] on blur/Enter; decimals allowed when `decimals` > 0) and
 *  steppable via the buttons (press-and-hold to repeat) or the Arrow keys. `zeroLabel`
 *  shows a word in place of 0 (e.g. "Never" / "Instant"). */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  decimals = 0,
  unit,
  zeroLabel,
  ariaLabel,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  unit?: string;
  zeroLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  // Refs so the press-and-hold repeat always steps from the LATEST value / handler — a
  // setInterval closure would otherwise capture a stale value and only ever move one step.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pow = 10 ** decimals;
  const round = (n: number) => Math.round(n * pow) / pow;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  function stopRepeat() {
    if (delayRef.current) clearTimeout(delayRef.current);
    if (repeatRef.current) clearInterval(repeatRef.current);
    delayRef.current = null;
    repeatRef.current = null;
  }
  const stepBy = (d: number) => {
    const next = round(clamp(valueRef.current + d));
    if (next === valueRef.current) {
      stopRepeat(); // hit a bound — stop repeating
      return;
    }
    onChangeRef.current(next);
  };
  // Press-and-hold: one step immediately, then repeat after a short delay (held mouse/touch).
  const press = (d: number) => {
    stepBy(d);
    stopRepeat();
    delayRef.current = setTimeout(() => {
      repeatRef.current = setInterval(() => stepBy(d), 70);
    }, 380);
  };

  // Resync when the value changes from outside (a −/+ press, a reset) — but never mid-typing:
  // we only commit on blur/Enter, so `value` stays put while you type and the field is stable.
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  useEffect(() => stopRepeat, []); // stop any running repeat on unmount

  const commit = () => {
    const n = decimals > 0 ? parseFloat(text) : parseInt(text, 10);
    const next = Number.isFinite(n) ? round(clamp(n)) : value;
    onChange(next);
    setText(String(next));
  };
  // Keep only digits — and, when decimals are allowed, a single leading dot.
  const filter = (raw: string) => {
    if (decimals <= 0) return raw.replace(/[^0-9]/g, "");
    const v = raw.replace(/[^0-9.]/g, "");
    const i = v.indexOf(".");
    return i === -1 ? v : v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "");
  };

  const showZero = !focused && zeroLabel != null && value === 0;
  const btn =
    "ring-signal grid h-full w-9 shrink-0 place-items-center text-dim transition-colors hover:bg-line/40 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dim";

  return (
    <div
      className={cn(
        "inline-flex h-10 items-stretch overflow-hidden rounded-xl border border-line bg-surface-2 transition-colors focus-within:border-faint",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <button
        type="button"
        aria-label={`Decrease${ariaLabel ? ` ${ariaLabel}` : ""}`}
        disabled={disabled || value <= min}
        onPointerDown={(e) => {
          if (e.button === 0) press(-step);
        }}
        onPointerUp={stopRepeat}
        onPointerLeave={stopRepeat}
        onPointerCancel={stopRepeat}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            stepBy(-step);
          }
        }}
        className={btn}
      >
        <Minus className="size-4" />
      </button>
      <div className="flex items-center justify-center gap-1 border-x border-line px-2">
        <input
          value={showZero ? zeroLabel : text}
          inputMode={decimals > 0 ? "decimal" : "numeric"}
          aria-label={ariaLabel}
          disabled={disabled}
          onFocus={(e) => {
            setFocused(true);
            setText(String(value));
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setText(filter(e.target.value))}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "ArrowUp") {
              e.preventDefault();
              stepBy(step);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              stepBy(-step);
            }
          }}
          className={cn(
            "w-16 bg-transparent text-center text-[13px] leading-none tabular-nums text-text outline-none",
            showZero && "text-dim",
          )}
        />
        {!showZero && unit && <span className="shrink-0 text-[12px] leading-none text-faint">{unit}</span>}
      </div>
      <button
        type="button"
        aria-label={`Increase${ariaLabel ? ` ${ariaLabel}` : ""}`}
        disabled={disabled || value >= max}
        onPointerDown={(e) => {
          if (e.button === 0) press(step);
        }}
        onPointerUp={stopRepeat}
        onPointerLeave={stopRepeat}
        onPointerCancel={stopRepeat}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            stepBy(step);
          }
        }}
        className={btn}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/* ── Button ───────────────────────────────────────────────────────────── */
export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  className,
  type = "button",
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "accent" | "ghost" | "danger";
  size?: "sm" | "md";
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "ring-signal inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-[12px]" : "h-10 px-4 text-[13px]",
        variant === "accent" && "bg-accent text-accent-ink hover:brightness-110",
        variant === "default" && "border border-line-strong bg-surface-2 text-text hover:border-faint",
        // Transparent border at rest reserves the box, so hover/press only
        // recolor it — no layout shift when the outline appears.
        variant === "ghost" &&
          "border border-transparent text-dim hover:border-line-strong hover:bg-surface-2 hover:text-text active:border-faint",
        variant === "danger" && "border border-rec/40 text-rec hover:bg-rec/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── Keycap ───────────────────────────────────────────────────────────── */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-line-strong bg-surface-2 px-2 font-mono text-[12px] text-text shadow-[0_1px_0_var(--c-line-strong)]">
      {children}
    </kbd>
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
  tone?: "ok" | "warn" | "rec" | "idle" | "faint" | "accent" | "live" | "dim" | "think" | "translate";
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

/* ── Stack (vertical rhythm) ──────────────────────────────────────────── */
// Spacing between stacked siblings is a CONTAINER responsibility, not a per-
// element one (margin is a property of the *relationship* between two elements).
// A Stack owns the vertical gap so its children stay margin-free; `gap` (not
// `space-y`) avoids margin-collapse + first/last-child leaks and self-heals when
// children are added/removed/reordered. Pick from a deliberate inner-≤-outer
// scale (bigger gaps for bigger/outer groups). Opt-in per container — NOT a
// global default — so existing tuned screens are unaffected.
const STACK_GAP = {
  1: "gap-1", //  4px — label ↔ control
  2: "gap-2", //  8px — rows / fields in a tight group
  3: "gap-3", // 12px — items in a list / sections in a block
  4: "gap-4", // 16px — blocks within a panel
  5: "gap-5", // 20px
  6: "gap-6", // 24px — major sections of a screen
  8: "gap-8", // 32px — page regions
} as const;

export function Stack({
  gap = 3,
  className,
  children,
}: {
  gap?: keyof typeof STACK_GAP;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("flex flex-col", STACK_GAP[gap], className)}>{children}</div>;
}

/* ── Setting row ──────────────────────────────────────────────────────── */
export function SettingRow({
  title,
  desc,
  children,
  last,
  disabled,
  expand,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  last?: boolean;
  disabled?: boolean;
  /** Sub-panel rendered INSIDE the row, below the header flex line — the
   *  row's border-b stays underneath it, so an expanded row reads as one
   *  unit instead of the panel floating between two rows. */
  expand?: ReactNode;
}) {
  // A bare role="switch" Toggle or an unlabeled <select> has no accessible name (the title is a
  // sibling <div>, not a <label htmlFor>). Auto-label a direct Toggle OR Select child with the row
  // title so a screen reader announces what it controls; respects an explicit ariaLabel and leaves
  // other control types untouched. (A control wrapped in its own <div> — e.g. the mic select with its
  // Refresh button — isn't a direct child, so those pass ariaLabel at the call site instead.)
  const control =
    isValidElement(children) && (children.type === Toggle || children.type === Select)
      ? cloneElement(children as ReactElement<{ ariaLabel?: string }>, {
          ariaLabel: (children.props as { ariaLabel?: string }).ariaLabel ?? title,
        })
      : children;
  // Grid, not flex: the control used to take whatever width it wanted and hand
  // the text the remainder, so a wide Segmented starved the description at ANY
  // page width — the "Insertion method" row wrapped to eight lines. A capped
  // control column gives the description a stable measure that doesn't shift as
  // controls change.
  //
  // Measured as a CONTAINER query on the row, not a viewport breakpoint: the
  // same component sits in Settings' full-width cards and in the Transcribe
  // studio's 420px rail, and only the row's own width says which layout fits.
  // Under 640px the control drops underneath instead of squeezing the text.
  return (
    <div className={cn("@container py-4", !last && "border-b border-line")}>
      <div className="flex flex-col gap-3 @[640px]:grid @[640px]:grid-cols-[minmax(0,1fr)_minmax(0,max-content)] @[640px]:items-center @[640px]:gap-6">
        <div className={cn("min-w-0 transition-opacity", disabled && "opacity-50")}>
          <div className="text-[14px] font-medium text-text">{title}</div>
          {desc && <div className="mt-0.5 text-[12.5px] leading-snug text-dim">{desc}</div>}
        </div>
        <div className="flex min-w-0 justify-start @[640px]:justify-end">{control}</div>
      </div>
      {expand}
    </div>
  );
}

/** The SettingRow sub-panel (`expand` slot) and its micro-labels — the
 *  Processing card's "options live INSIDE the row" idiom. */
export function SettingExpand({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2.5 space-y-3 rounded-xl border border-line bg-surface-2/40 p-3.5">
      {children}
    </div>
  );
}

export function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-label text-faint">
      {children}
    </div>
  );
}
