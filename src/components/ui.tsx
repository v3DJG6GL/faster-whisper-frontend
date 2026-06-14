import { type ReactNode, type InputHTMLAttributes, forwardRef, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
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

/* ── Toggle (pill switch) ─────────────────────────────────────────────── */
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          "ring-signal h-10 w-full appearance-none rounded-xl border border-line bg-surface-2 pl-3.5 pr-9 text-[13px] text-text",
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
export function StatusDot({ tone = "ok", pulse }: { tone?: "ok" | "warn" | "rec" | "idle"; pulse?: boolean }) {
  const color = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : tone === "rec" ? "bg-rec" : "bg-faint";
  return <span className={cn("inline-block size-2 rounded-full", color, pulse && "animate-rec-pulse")} />;
}

/* ── Setting row ──────────────────────────────────────────────────────── */
export function SettingRow({
  title,
  desc,
  children,
  last,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-6 py-4", !last && "border-b border-line")}>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-text">{title}</div>
        {desc && <div className="mt-0.5 text-[12.5px] leading-snug text-dim">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
