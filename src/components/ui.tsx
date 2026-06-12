import { type ReactNode, type InputHTMLAttributes, forwardRef } from "react";
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
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-pill border border-line bg-surface-2 p-[3px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "ring-signal rounded-pill px-3.5 py-1 text-[13px] font-medium transition-colors",
              active ? "bg-accent text-accent-ink" : "text-dim hover:text-text",
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
