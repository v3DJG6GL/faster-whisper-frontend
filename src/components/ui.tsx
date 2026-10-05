import {
  type ComponentProps,
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
import type { LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Info, Minus, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { langCode, languageLabel } from "@/lib/languages";
import { safeDisplayText } from "@/lib/sanitize";
import { KeyHint, ListPicker } from "@/components/ListPicker";

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
export function PageHeader({ eyebrow, title, icon: Icon, children }: { eyebrow: string; title: string; icon?: LucideIcon; children: ReactNode }) {
  return (
    <>
      <div className="font-mono text-[11px] uppercase tracking-label text-accent">{eyebrow}</div>
      <h1 className="mt-2 flex items-center gap-2.5 font-display text-[30px] font-bold tracking-tight text-text">
        {Icon && <Icon className="size-7 text-accent" aria-hidden />}
        {title}
      </h1>
      <p className="mt-2 text-[13.5px] text-dim">{children}</p>
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
  icon,
  children,
  showAdd,
  addLabel,
  onAdd,
}: {
  eyebrow: string;
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
  showAdd: boolean;
  addLabel: string;
  onAdd: () => void;
}) {
  // The heading block stands alone; the page's actions start a row of their own under
  // the lede, so the description never shares a line with a button.
  return (
    <div>
      <PageHeader eyebrow={eyebrow} title={title} icon={icon}>
        {children}
      </PageHeader>
      {showAdd && (
        <div className="page-content flex justify-start">
          <Button variant="accent" onClick={onAdd}>
            <Plus className="size-4" /> {addLabel}
          </Button>
        </div>
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
    source: safeDisplayText(languageLabel(source), 24),
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

/** The summary after a disclosure's title: "· 3 set" in the accent while the block holds
 *  overrides, else what it inherits ("· inherit backend"), quiet. */
export function SetSummary({ count, inherit }: { count: number; inherit: string }) {
  return count > 0 ? (
    <span className="text-accent">· {count} set</span>
  ) : (
    <span className="text-faint">· {inherit}</span>
  );
}

/** A disclosure whose HEADER LIVES INSIDE THE BOX: the title, a summary of what is inside
 *  ("· 2 set" / "· inherit backend"), and a chevron at the far end. Every block starts closed
 *  (the caller's state); an OPEN block stands out — accent edge, accent-soft header, accent
 *  title and chevron — so it is clear which one you are in. `nested` is the sub-panel scale
 *  for a block inside another; `hint` is the header's tooltip (no prose inside the block). */
export function DisclosureCard({
  open,
  onToggle,
  title,
  summary,
  hint,
  nested,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  /** Right after the title, e.g. <SetSummary/>. */
  summary?: ReactNode;
  hint?: string;
  nested?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div
      className={cn(
        "border transition-colors",
        nested ? "rounded-xl bg-surface-2/40" : "rounded-card bg-surface/80",
        open ? "border-accent/45" : "border-line",
        className,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={hint}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined} // the panel node exists only while open (Combobox rule)
        className={cn(
          "group ring-signal flex w-full items-center gap-2 text-left",
          nested ? "rounded-[11px] px-4 py-3 text-[13px]" : "rounded-[13px] px-[18px] py-3.5 text-[14px]",
          open && "rounded-b-none bg-accent-soft",
        )}
      >
        <span className={cn("min-w-0 font-medium", open ? "text-accent" : "text-text")}>{title}</span>
        {summary && <span className="min-w-0 truncate text-[12.5px]">{summary}</span>}
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 transition-transform",
            open ? "text-accent" : "-rotate-90 text-faint group-hover:text-text",
          )}
        />
      </button>
      {open && (
        <div id={panelId} className={nested ? "px-4 pb-2 pt-1" : "px-[18px] pb-3 pt-1.5"}>
          {children}
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
  /** `title`: a tooltip for one option (e.g. where an inherited value comes from);
   *  `icon` leads the label, `dot` marks the option (e.g. "has corrections"),
   *  `disabled` greys out just that option. */
  options: { value: T; label: string; title?: string; icon?: LucideIcon; dot?: boolean; disabled?: boolean }[];
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
        const off = disabled || o.disabled;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            // Single-select state for screen readers (mirrors Toggle's role=switch and the Dictionary
            // pin's aria-pressed) — otherwise the active option reads as just another plain button.
            aria-pressed={active}
            disabled={off}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              // Labels are short by design and read as one token ("Clipboard paste"):
              // wrapping one across two lines makes the group look broken.
              "ring-signal inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 py-1 text-[13px] font-medium transition-colors",
              active ? "bg-accent text-accent-ink" : "text-dim hover:text-text",
              off && "cursor-not-allowed hover:text-dim",
              o.disabled && !disabled && "opacity-40",
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {o.label}
            {o.dot && <span aria-hidden className={cn("size-1.5 rounded-full", active ? "bg-accent-ink" : "bg-accent")} />}
          </button>
        );
      })}
    </div>
  );
}

/* ── RangeField (labelled slider with a reset) ────────────────────────── */
/** A labelled range slider with its value, and a ↺ reset while the value
 *  differs from `defaultValue`. Reuses the Settings sliders' styling. */
export function RangeField({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  defaultValue,
  onChange,
  onReset,
  hideLabel,
  inherited,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Appended to the shown value (" s", " chars/s"). */
  unit?: string;
  defaultValue: number;
  onChange: (v: number) => void;
  /** What ↺ does instead of setting `defaultValue` (an override editor: back to inherit). */
  onReset?: () => void;
  /** The label is the slider's accessible name only (a setting row already titles it). */
  hideLabel?: boolean;
  /** The value shown is inherited, not set here: greyed. */
  inherited?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "grid items-center gap-3 text-[12.5px] text-dim",
        hideLabel ? "grid-cols-[10.5rem_3.5rem_1.75rem]" : "grid-cols-[minmax(0,9rem)_minmax(0,1fr)_5.5rem_1.75rem]",
      )}
    >
      {!hideLabel && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        aria-label={hideLabel ? label : undefined}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="ring-signal h-2 w-full cursor-pointer appearance-none rounded-pill bg-surface-2 disabled:cursor-not-allowed"
      />
      <output
        htmlFor={id}
        className={cn("text-right font-mono text-[12px] tabular-nums", inherited ? "text-faint" : "text-text")}
      >
        {value}
        {unit}
      </output>
      {(onReset ? !inherited : value !== defaultValue) ? (
        <button
          type="button"
          title={`Reset to ${defaultValue}${unit}`}
          aria-label={`Reset ${label.toLowerCase()} to ${defaultValue}${unit}`}
          disabled={disabled}
          onClick={() => (onReset ? onReset() : onChange(defaultValue))}
          className="ring-signal grid size-7 place-items-center rounded-lg text-accent hover:bg-surface-2"
        >
          <RotateCcw className="size-3.5" />
        </button>
      ) : (
        <span />
      )}
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

/** Lists longer than this get a search field. */
const SELECT_SEARCH_MIN = 9;

/** A single-choice dropdown: the app's ListPicker under a FieldTrigger face, as wide as its
 *  field. Picking the current option again changes nothing (no onChange). A value that matches
 *  no option shows the first option, as a native select did. */
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
  /** `chips`: small badges after an option's label (e.g. a backend's version and device),
   *  in its row and on the closed field. */
  options: { value: T; label: string; chips?: string[] }[];
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  type Option = { value: T; label: string; chips?: string[] };
  const picked = options.find((o) => o.value === value) ?? options[0];
  const current = picked?.label ?? "";
  const chips = (list: string[] | undefined) =>
    list?.map((c) => (
      <span key={c} className="ml-1.5">
        <Badge>{c}</Badge>
      </span>
    ));
  const search = options.length >= SELECT_SEARCH_MIN;
  return (
    <div className={className}>
      <ListPicker<Option>
        label={ariaLabel ?? current}
        sections={(query) => {
          const q = query.trim().toLowerCase();
          return [{ title: "", rows: q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options }];
        }}
        rowKey={(o) => o.value}
        isSelected={(o) => o.value === value}
        onPick={(o) => {
          if (o.value !== value) onChange(o.value);
        }}
        renderRow={(o, { selected }) => (
          <>
            <span className="grid size-4 shrink-0 place-items-center">
              {selected && <Check className="size-3.5 text-accent" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-text">{o.label}</span>
            {o.chips?.length ? <span className="shrink-0">{chips(o.chips)}</span> : null}
          </>
        )}
        renderTrigger={(p) => (
          <FieldTrigger {...p} open={p["aria-expanded"]} aria-label={ariaLabel ? `${ariaLabel}: ${current}` : undefined}>
            {current}
            {chips(picked?.chips)}
          </FieldTrigger>
        )}
        search={search}
        minWidth={0}
        placeholder="Search"
        keys={
          <>
            <KeyHint k="↑↓">move</KeyHint>
            <KeyHint k="Enter">pick</KeyHint>
            <KeyHint k="Esc">close</KeyHint>
          </>
        }
        disabled={disabled}
      />
    </div>
  );
}

/* ── Stepper (numeric spinner) ────────────────────────────────────────── */
/** A −/+ numeric field for granular timeout-style settings. The value is typeable
 *  (clamped to [min,max] on blur/Enter; decimals allowed when `decimals` > 0) and
 *  steppable via the buttons (press-and-hold to repeat) or the Arrow keys. `zeroLabel`
 *  shows a word in place of 0 (e.g. "Never" / "Instant").
 *
 *  Inherit state (override editors): `value` undefined shows `inherited` greyed with
 *  "· {inheritNote}" after it, and the first step or typed number becomes the override;
 *  `onReset` adds a ↺ that goes back to inherit while a value is set. */
export function Stepper({
  value: own,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  decimals = 0,
  unit,
  zeroLabel,
  ariaLabel,
  disabled,
  inherited,
  inheritNote,
  onReset,
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  unit?: string;
  zeroLabel?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** What an unset value inherits (shown greyed); unknown = `min`. */
  inherited?: number;
  /** Who the inherited value belongs to ("server", "backend"). */
  inheritNote?: string;
  onReset?: () => void;
}) {
  const inheriting = own === undefined;
  const value = own ?? inherited ?? min;
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
    // Focusing and leaving an inheriting field changes nothing: only a typed number overrides.
    if (inheriting && text === String(value)) return;
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
            (showZero || (inheriting && !focused)) && "text-faint",
          )}
        />
        {!showZero && unit && <span className="shrink-0 text-[12px] leading-none text-faint">{unit}</span>}
        {inheriting && inheritNote && !focused && (
          <span className="shrink-0 whitespace-nowrap text-[12px] leading-none text-faint">· {inheritNote}</span>
        )}
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
      {onReset && !inheriting && (
        <button
          type="button"
          title={inheritNote ? `Back to the ${inheritNote} value` : "Reset to inherited"}
          aria-label={`Reset${ariaLabel ? ` ${ariaLabel}` : ""}`}
          disabled={disabled}
          onClick={onReset}
          className={cn(btn, "w-8 border-l border-line text-faint")}
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
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

/* ── ChipToggle ───────────────────────────────────────────────────────── */
const CHIP_TOGGLE_SIZE = {
  xs: "h-6 px-2.5 text-[11px]",
  sm: "h-7 px-3 text-[12px]",
  md: "h-[30px] px-3 text-[12.5px]",
  // Inline with the player bar's speed pill: no fixed height.
  bar: "px-2.5 py-0.5 text-[11.5px]",
} as const;

/** A pill that switches something on or off (aria-pressed): filled accent when on.
 *  `tab` makes it one tab of a tablist (aria-selected). `lock` pins it on (ok tone —
 *  always included) or off (struck through) while keeping it focusable, so its title
 *  still explains why; `disabled` greys out an option that is unavailable right now. */
export function ChipToggle({
  on,
  disabled,
  lock,
  tab,
  size = "sm",
  title,
  onClick,
  className,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  lock?: "on" | "off";
  tab?: boolean;
  size?: keyof typeof CHIP_TOGGLE_SIZE;
  title?: string;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={tab ? "tab" : undefined}
      aria-selected={tab ? on : undefined}
      aria-pressed={tab ? undefined : on || lock === "on"}
      aria-disabled={lock ? true : undefined}
      disabled={disabled}
      title={title}
      onClick={lock ? undefined : onClick}
      className={cn(
        "ring-signal inline-flex items-center gap-1.5 rounded-pill border transition-colors",
        CHIP_TOGGLE_SIZE[size],
        lock === "on"
          ? "cursor-default border-ok/35 text-ok"
          : lock === "off"
            ? "cursor-not-allowed border-line bg-surface-2 text-dim line-through opacity-45"
            : on
              ? "border-accent/35 bg-accent-soft text-accent"
              : "border-line bg-surface-2 text-dim hover:text-text",
        disabled && "cursor-not-allowed opacity-50 hover:text-dim",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── CodeChip ─────────────────────────────────────────────────────────── */
/** A chosen language code that a click removes ("DE ×"). `head` = a CompoundChip's code
 *  segment (the compound draws the outline); `size="md"` = the language picker's route rail. */
export function CodeChip({
  code,
  onRemove,
  disabled,
  head,
  size = "sm",
}: {
  code: string;
  onRemove: () => void;
  disabled?: boolean;
  head?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRemove}
      title={`Remove ${languageLabel(code)}`}
      className={cn(
        "ring-signal group inline-flex items-center gap-1.5 rounded-pill border px-2.5 font-mono",
        size === "sm" ? "h-7 text-[11.5px]" : "py-1 text-[12px]",
        // Selection chrome takes the accent; teal is reserved for the translating STAGE.
        "border-accent/50 text-accent transition-colors",
        // A click removes the chip, so hover/press previews that in the danger tone.
        "enabled:hover:border-rec/45 enabled:hover:bg-rec/10 enabled:hover:text-rec enabled:active:bg-rec/20",
        disabled && "opacity-50",
        head && "rounded-none border-0",
      )}
    >
      {langCode(code, 12)}
      <span aria-hidden className="opacity-60 transition-opacity group-enabled:group-hover:opacity-100">
        ×
      </span>
    </button>
  );
}

/* ── FieldTrigger ─────────────────────────────────────────────────────── */
/** A dropdown's closed face drawn as a form field: the current value and a chevron. `open`
 *  outlines it in the accent while its list is up; `sm` = a table row's compact field. */
export function FieldTrigger({
  open,
  size = "md",
  className,
  children,
  ...rest
}: ComponentProps<"button"> & { open?: boolean; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "ring-signal flex w-full items-center justify-between gap-2 border border-line bg-surface-2 text-left",
        size === "md" ? "h-10 rounded-xl pl-3.5 pr-3 text-[13px] text-text" : "h-8 rounded-lg px-2.5 text-[12.5px] text-dim",
        open && "border-accent/55",
        rest.disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ChevronDown className={cn("shrink-0 text-faint", size === "md" ? "size-4" : "size-3.5")} />
    </button>
  );
}

/* ── IconButton ───────────────────────────────────────────────────────── */
/** A square outlined button holding one icon; `label` is its accessible name and tooltip.
 *  Hover takes the accent, or the danger tone for a removal. */
export function IconButton({
  label,
  onClick,
  disabled,
  size = "md",
  danger,
  expanded,
  controls,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
  danger?: boolean;
  /** A disclosure button: whether its panel is open (aria-expanded, accent while open). */
  expanded?: boolean;
  /** The panel's id (aria-controls). */
  controls?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      title={label}
      onClick={onClick}
      className={cn(
        "ring-signal grid place-items-center rounded-lg border border-line-strong bg-surface-2 text-dim",
        size === "sm" ? "size-7" : "size-8",
        danger ? "enabled:hover:border-rec/45 enabled:hover:text-rec" : "enabled:hover:border-accent/45 enabled:hover:text-accent",
        expanded && "border-accent/45 text-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── Keycap ───────────────────────────────────────────────────────────── */
/** `md` = a key on its own; `sm` / `xs` = a key inside a hint line (QuickAdd's footer, a
 *  picker's keys). */
export function Kbd({ size = "md", children }: { size?: "md" | "sm" | "xs"; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "border border-line-strong bg-surface-2 font-mono",
        size === "md"
          ? "inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-[12px] text-text shadow-[0_1px_0_var(--c-line-strong)]"
          : "rounded-md px-1.5 py-0.5 leading-none text-dim",
        size === "sm" && "text-[11px]",
        size === "xs" && "text-[10.5px]",
      )}
    >
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
  disabledReason,
  expand,
}: {
  /** A string, deliberately: it doubles as the accessible name auto-cloned onto a
   *  Toggle/Select child below, which a node could not provide. */
  title: string;
  desc?: string;
  children: ReactNode;
  last?: boolean;
  disabled?: boolean;
  /** WHY this row is inactive, shown at full contrast IN PLACE OF `desc`.
   *
   *  A dimmed row with no explanation is the defect this exists to fix: the reader can
   *  see that a control is unavailable and has no way to learn what would make it
   *  available. Greying is kept — Microsoft's guidance endorses disabling subordinate
   *  controls, and GNOME/elementary both prefer insensitive over hidden for "available
   *  once a condition is met" — but greying ALONE is what fails. Two sentences, in the
   *  shape Microsoft's balloon guidance recommends: the condition, then how to change it.
   *
   *  Not dimmed with the rest of the block: the reason is the one thing on a dead row
   *  that must stay readable, and WCAG's contrast exemption for inactive controls makes
   *  a dim explanation conformant but useless. */
  disabledReason?: string;
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
        <div className="min-w-0">
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-medium text-text transition-opacity",
              disabled && "opacity-50",
            )}
          >
            {title}
          </div>
          {/* The reason REPLACES the description and keeps full contrast — see the prop's
              doc. When there's no reason, the description dims with the rest of the row. */}
          {disabled && disabledReason ? (
            <div className="mt-0.5 text-[12.5px] leading-snug text-warn">{disabledReason}</div>
          ) : (
            desc && (
              <div
                className={cn(
                  "mt-0.5 text-[12.5px] leading-snug text-dim transition-opacity",
                  disabled && "opacity-50",
                )}
              >
                {desc}
              </div>
            )
          )}
        </div>
        <div className="flex min-w-0 justify-start @[640px]:justify-end">{control}</div>
      </div>
      {expand}
    </div>
  );
}

/** The SettingRow sub-panel (`expand` slot) and its micro-labels — the
 *  Processing card's "options live INSIDE the row" idiom. */
export function SettingExpand({ children, id, open }: { children: ReactNode; id?: string; open?: boolean }) {
  // `open`: a panel the user unfolded (StageOptions) — the accent edge an open DisclosureCard has.
  return (
    <div
      id={id}
      className={cn("mt-2.5 space-y-3 rounded-xl border bg-surface-2/40 p-3.5", open ? "border-accent/45" : "border-line")}
    >
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
