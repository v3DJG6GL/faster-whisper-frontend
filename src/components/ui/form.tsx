import {
  type ReactNode, type ReactElement, type InputHTMLAttributes, type TextareaHTMLAttributes, cloneElement,
  forwardRef, isValidElement, useEffect, useId, useRef, useState,
} from "react";
import type { LucideIcon } from "lucide-react";
import { Check, Minus, Plus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
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
  // Keep only digits — a leading minus when the range goes below zero, and, when decimals are
  // allowed, a single dot.
  const filter = (raw: string) => {
    const neg = min < 0 && raw.trimStart().startsWith("-") ? "-" : "";
    if (decimals <= 0) return neg + raw.replace(/[^0-9]/g, "");
    const v = raw.replace(/[^0-9.]/g, "");
    const i = v.indexOf(".");
    return neg + (i === -1 ? v : v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, ""));
  };

  const showZero = !focused && zeroLabel != null && value === 0;
  const showInheritedText = !focused && inheriting && inherited === undefined && inheritedText != null;
  const btn =
    "ring-signal grid h-full w-9 shrink-0 place-items-center text-dim transition-colors hover:bg-line/40 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dim";

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
      <div className="flex flex-1 items-center justify-center gap-1 border-x border-line px-2">
        <input
          value={showZero ? zeroLabel : showInheritedText ? inheritedText : text}
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
