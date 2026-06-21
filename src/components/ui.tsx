import {
  type ReactNode,
  type ReactElement,
  type InputHTMLAttributes,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Check, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

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

/* ── Badge ────────────────────────────────────────────────────────────── */
/** A small uppercase pill. `accent` = highlighted, `warn` = caution, default = dim. */
export function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "dim" | "warn" }) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider",
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
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
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

/** A form field with a small dim label above its control. */
export function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="mb-2 block text-[12px] font-medium text-dim">{label}</label>
      {children}
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
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "ring-signal relative h-[26px] w-[46px] shrink-0 rounded-pill border transition-colors duration-200",
        checked ? "border-accent bg-accent" : "border-line-strong bg-surface-2",
        disabled && "opacity-40",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full transition-all duration-200",
          checked ? "left-[23px] bg-accent-ink" : "left-[3px] bg-faint",
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
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div
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
              "ring-signal rounded-pill px-3.5 py-1 text-[13px] font-medium transition-colors",
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

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        disabled={disabled}
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
        variant === "ghost" && "text-dim hover:bg-surface-2 hover:text-text",
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
  tone?: "ok" | "warn" | "rec" | "idle" | "faint" | "accent" | "live" | "dim";
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
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  last?: boolean;
  disabled?: boolean;
}) {
  // A bare role="switch" Toggle has no accessible name (the title is a sibling <div>). Auto-label a
  // direct Toggle child with the row title so a screen reader announces what it controls; respects an
  // explicit ariaLabel and leaves other control types untouched.
  const control =
    isValidElement(children) && children.type === Toggle
      ? cloneElement(children as ReactElement<{ ariaLabel?: string }>, {
          ariaLabel: (children.props as { ariaLabel?: string }).ariaLabel ?? title,
        })
      : children;
  return (
    <div className={cn("flex items-center gap-6 py-4", !last && "border-b border-line")}>
      <div className={cn("min-w-0 flex-1 transition-opacity", disabled && "opacity-50")}>
        <div className="text-[14px] font-medium text-text">{title}</div>
        {desc && <div className="mt-0.5 text-[12.5px] leading-snug text-dim">{desc}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
