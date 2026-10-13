import {
  type ReactNode, type ReactElement, type InputHTMLAttributes, type TextareaHTMLAttributes, cloneElement,
  forwardRef, isValidElement, useEffect, useId, useRef, useState,
} from "react";
import type { LucideIcon } from "lucide-react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { isHistoryTraversalKey } from "@/lib/navGuard";
import { KeyHint, ListPicker } from "@/components/ListPicker";
import { FieldTrigger } from "@/components/ui/buttons";
import { Badge } from "@/components/ui/feedback";

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
   *  (mixed → all-on → all-off) — `onChange` still receives a boolean.
   *  ARIA `switch` has no mixed value, so the mixed state is exposed as a
   *  tri-state checkbox instead (otherwise screen readers announce "off"). */
  checked: boolean | "mixed";
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const mixed = checked === "mixed";
  return (
    <button
      type="button"
      role={mixed ? "checkbox" : "switch"}
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
              active ? "bg-accent text-accent-ink" : "text-dim enabled:hover:text-text",
              off && "cursor-not-allowed",
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
        // Dimmed like Stepper's frame: a locked/unavailable slider must not look live.
        disabled && "opacity-40",
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
          className="ring-signal grid size-7 place-items-center rounded-lg text-accent enabled:hover:bg-surface-2 disabled:cursor-not-allowed"
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
/** `set` draws the accent edge of a field that holds its own value (an override). A choice, not a
 *  className border: cn is clsx (no merge) and the built CSS emits border-line after
 *  border-accent/55, so an appended one would lose. */
type SetProp = { set?: boolean };
/** A text input's size, a choice for the same reason as `set`: the built CSS emits h-8 before
 *  h-10 and text-[12px]/text-[12.5px] before text-[13px], so an appended size class would lose.
 *  `compact` is the 32px row at 12px (Button sm parity); `mono` sets monospace at 12.5px. */
type SizeProps = { compact?: boolean; mono?: boolean };

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & SetProp & SizeProps>(
  function TextInput({ className, set, compact, mono, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "ring-signal w-full rounded-xl border bg-surface-2 px-3.5 text-text",
          compact ? "h-8" : "h-10",
          mono ? "font-mono text-[12.5px]" : compact ? "text-[12px]" : "text-[13px]",
          "placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 disabled:placeholder:text-dim",
          set ? "border-accent/55" : "border-line",
          className,
        )}
        {...props}
      />
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & SetProp>(
  function TextArea({ className, set, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "ring-signal w-full resize-none rounded-xl border bg-surface-2 px-3.5 py-2.5 text-[13px] text-text",
          "placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 disabled:placeholder:text-dim",
          set ? "border-accent/55" : "border-line",
          className,
        )}
        {...props}
      />
    );
  },
);

/** Lists with at least this many options get a search field. */
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
 *  (clamped to [min,max] on blur/Enter, and Esc reverts uncommitted typing; decimals
 *  allowed when `decimals` > 0) and
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
  describedBy,
  disabled,
  inherited,
  inheritNote,
  inheritedText,
  onReset,
  className,
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
  /** `aria-describedby` for the inner input (e.g. the row's inherited-source note). */
  describedBy?: string;
  disabled?: boolean;
  /** What an unset value inherits (shown greyed); unknown = `min`. */
  inherited?: number;
  /** Who the inherited value belongs to ("server", "backend"). */
  inheritNote?: string;
  /** What an unset value inherits when that isn't a number ("off" for a threshold the server
   *  leaves unset): shown greyed in place of the number. */
  inheritedText?: string;
  onReset?: () => void;
  /** Sizing for the frame (e.g. "w-full" in a form grid: the value column takes the slack). */
  className?: string;
}) {
  const inheriting = own === undefined;
  const value = own ?? inherited ?? min;
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  // Refs so the press-and-hold repeat always steps from the LATEST value / handler — a
  // setInterval closure would otherwise capture a stale value and only ever move one step.
  const valueRef = useRef(value);
  valueRef.current = value;
  // …and from the typed-but-uncommitted text while focused: an Arrow key or −/+ press after
  // typing steps from what's in the field, not from the last committed value.
  const textRef = useRef(text);
  textRef.current = text;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Whether the user typed since focusing: with no numeric inherited value the field shows
  // `min` as a placeholder, so "text still equals value" can't tell focus-and-leave apart
  // from deliberately typing the minimum.
  const editedRef = useRef(false);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pow = 10 ** decimals;
  const round = (n: number) => Math.round(n * pow) / pow;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const parse = (s: string) => (decimals > 0 ? parseFloat(s) : parseInt(s, 10));
  // What −/+ step from: the typed text once the user typed since focusing, else the committed
  // value — an untouched focused field steps exactly like an unfocused one (an out-of-range own
  // value isn't clamped first, and a value that moved under the focus isn't stepped from stale
  // text). stepBy and the buttons' disabled bounds share it so they can't disagree about where a
  // bound is.
  const stepBase = (t: string, f: boolean, v: number) => {
    const n = parse(t);
    return f && editedRef.current && Number.isFinite(n) ? round(clamp(n)) : v;
  };

  function stopRepeat() {
    if (delayRef.current) clearTimeout(delayRef.current);
    if (repeatRef.current) clearInterval(repeatRef.current);
    delayRef.current = null;
    repeatRef.current = null;
  }
  const stepBy = (d: number) => {
    const base = stepBase(textRef.current, focusedRef.current, valueRef.current);
    const next = round(clamp(base + d));
    // Not moving in the step's direction is a bound too: an untouched out-of-range base (500 with
    // max 100) would otherwise clamp to the far bound, so ↑ lowered it.
    if (d > 0 ? next <= base : next >= base) {
      // Hit a bound — still commit a typed number that differs, then stop repeating. Only a typed
      // one: an untouched field showing an out-of-range value (own or inherited) must not be
      // pulled to the bound — that would change it and pin an override on an inheriting field.
      if (base !== valueRef.current && editedRef.current) {
        onChangeRef.current(base);
        textRef.current = String(base);
        setText(String(base));
      }
      stopRepeat();
      return;
    }
    onChangeRef.current(next);
    // The resync effect skips a focused field, so follow the step here — else the blur commit
    // would re-commit the pre-step text and undo an Arrow-key or −/+ step made while focused.
    // The ref too: a held repeat ticks before the re-render and must step from `next`.
    textRef.current = String(next);
    setText(String(next));
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
    const n = parse(text);
    // Focusing and leaving an inheriting field changes nothing, nor does emptying it or leaving
    // a lone "-" / ".": only a typed number overrides. An untouched field is unchanged even when
    // the inherited value moved under it while focused (the text still holds the old one);
    // retyping the inherited value is unchanged too — in any spelling ("05", "0.50"), and without
    // clamping, so an out-of-range inherited value retyped verbatim isn't pinned to the bound —
    // while typing `min` with no numeric inherited value still overrides.
    const unchanged =
      !editedRef.current ||
      (inherited !== undefined && (text === String(value) || (Number.isFinite(n) && round(n) === value)));
    if (inheriting && (unchanged || !Number.isFinite(n))) {
      setText(String(value));
      return;
    }
    // Nor does focusing and leaving an own value untouched: a stored value outside [min, max]
    // must survive unclamped (a step made while focused already committed in stepBy).
    if (!inheriting && !editedRef.current) {
      setText(String(value));
      return;
    }
    const next = Number.isFinite(n) ? round(clamp(n)) : value;
    onChange(next);
    setText(String(next));
  };
  // Keep only digits — a leading minus when the range goes below zero, and, when decimals are
  // allowed, a single dot.
  const filter = (raw: string) => {
    const neg = min < 0 && raw.trimStart().startsWith("-") ? "-" : "";
    if (decimals <= 0) return neg + raw.replace(/[^0-9]/g, "");
    const v = raw.replace(/[^0-9.]/g, "");
    const i = v.indexOf(".");
    return neg + (i === -1 ? v : v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, ""));
  };

  // −/+ step from the typed text while focused (stepBy), so their bounds must too.
  const cur = stepBase(text, focused, value);
  const showInheritedText = !focused && inheriting && inherited === undefined && inheritedText != null;
  // The inherited text wins over the zero label: an unset field with no numeric inherited value
  // shows `min` (often 0) only as a placeholder, not as a value the user set to "off".
  const showZero = !focused && zeroLabel != null && value === 0 && !showInheritedText;
  const btn =
    "ring-signal grid h-full shrink-0 place-items-center text-dim transition-colors hover:bg-line/40 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dim";

  return (
    <div
      className={cn(
        "inline-flex h-10 items-stretch overflow-hidden rounded-xl border border-line bg-surface-2 transition-colors focus-within:border-faint",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <button
        type="button"
        aria-label={`Decrease${ariaLabel ? ` ${ariaLabel}` : ""}`}
        disabled={disabled || cur <= min}
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
        className={cn(btn, "w-9")}
      >
        <Minus className="size-4" />
      </button>
      <div className="flex flex-1 items-center justify-center gap-1 border-x border-line px-2">
        <input
          value={showZero ? zeroLabel : showInheritedText ? inheritedText : text}
          inputMode={decimals > 0 ? "decimal" : "numeric"}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          disabled={disabled}
          onFocus={(e) => {
            setFocused(true);
            editedRef.current = false;
            setText(String(value));
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => {
            // A keystroke the filter drops entirely (a letter after the "0" placeholder) leaves
            // the text as it was and isn't an edit; one it keeps verbatim is, even when it
            // retypes the same text (typing the minimum over the selected placeholder).
            const raw = e.target.value;
            const t = filter(raw);
            if (t !== text || t === raw) editedRef.current = true;
            setText(t);
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            // Esc drops the uncommitted typing and stays here: the text only commits on blur/Enter,
            // so an editor's window Esc would read its dirty state without it and leave unguarded,
            // losing the number in silence. An untouched field lets Esc through (to leave), and so
            // does one whose typing a step (Arrow / −/+) already committed: the text then equals
            // the value, nothing is left to drop, and swallowing that Esc made the user press it
            // twice. Typing `min` over the placeholder of a field with no numeric inherited value
            // still counts as uncommitted — its blur would pin an override.
            const uncommitted =
              textRef.current !== String(value) || (inheriting && inherited === undefined);
            if (e.key === "Escape" && editedRef.current && uncommitted) {
              e.preventDefault();
              e.stopPropagation();
              editedRef.current = false;
              textRef.current = String(value);
              setText(String(value));
              return;
            }
            // The Esc rule's sibling: a keyboard history traversal goes through the popstate
            // guard, which would read the editor clean before the typed number lands. Blurring
            // commits it first; the key itself still goes through, so the guard asks.
            if (editedRef.current && uncommitted && isHistoryTraversalKey(e)) {
              e.currentTarget.blur();
              return;
            }
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
            "w-16 bg-transparent text-center text-[13px] leading-none tabular-nums outline-none",
            showZero ? "text-dim" : inheriting && !focused ? "text-faint" : "text-text",
          )}
        />
        {!showZero && !showInheritedText && unit && <span className="shrink-0 text-[12px] leading-none text-faint">{unit}</span>}
        {inheriting && inheritNote && !focused && (
          <span className="shrink-0 whitespace-nowrap text-[12px] leading-none text-faint">· {inheritNote}</span>
        )}
      </div>
      <button
        type="button"
        aria-label={`Increase${ariaLabel ? ` ${ariaLabel}` : ""}`}
        disabled={disabled || cur >= max}
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
        className={cn(btn, "w-9")}
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
