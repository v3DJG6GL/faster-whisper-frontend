// The one row every override editor uses (Profile over Backend, Backend over server, a run over
// both): the setting's name — its server ENV name where it has one — with the backend's short
// description under it, and the control on the right. An accent dot marks a field that holds an
// override; "clear" writes the explicit EMPTY override (text only), "reset" goes back to inherit.
// A field the server admin locked shows a lock whose reason is the control's description.
//
// Nothing else explains a setting in prose: a row that cannot be used right now says why in its
// tooltip (`disabledTitle`).
import type { ReactNode } from "react";
import { Eraser, Lock, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { escapeText, unescapeText } from "@/lib/escapeText";
import { overrideTextPlaceholder, type InheritWord } from "@/lib/inherit";
import { TextArea, TextInput } from "@/components/ui";

const ACTION =
  "ring-signal inline-flex items-center gap-1 rounded-md px-1 text-[11px] text-faint hover:text-text";


export function OverrideHeader({
  title,
  env = true,
  desc,
  hint,
  overridden = false,
  lockReason,
  describedById,
  onClear,
  canClear = true,
  clearTitle = "Override with empty (suppress the inherited value)",
  onReset,
  disabled,
  disabledTitle,
  dot,
  dotTitle,
  note,
  wide,
  last,
  children,
}: {
  /** The server ENV name (`env`, mono) or, for a setting only the app has, its plain name. */
  title: string;
  env?: boolean;
  desc?: ReactNode;
  /** The title's tooltip — what an app-only setting does (they have no backend description). */
  hint?: string;
  /** The field holds an override (empty or not): the accent dot, and the reset. */
  overridden?: boolean;
  /** Set when an admin locked the key: the lock icon, and its reason for screen readers. */
  lockReason?: string;
  /** The id the control's `aria-describedby` names; the lock reason is rendered under it. */
  describedById?: string;
  /** Text fields: write the explicit empty override. Hidden while `canClear` is false. */
  onClear?: () => void;
  canClear?: boolean;
  clearTitle?: string;
  /** Back to inherit; offered while `overridden`. */
  onReset?: () => void;
  /** The whole row is unusable right now; `disabledTitle` says why (tooltip). */
  disabled?: boolean;
  disabledTitle?: string;
  /** A colour (CSS value) marking the row, e.g. the live preview's chip colour for this pause. */
  dot?: string;
  dotTitle?: string;
  /** A short status under the control (e.g. "ignored · locked by the server"). */
  note?: ReactNode;
  /** The control takes its own full-width line under the title (prompts, glossaries). */
  wide?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  const showClear = !!onClear && canClear && !disabled && !lockReason;
  const showReset = !!onReset && overridden && !disabled;
  return (
    <div
      title={disabled ? disabledTitle : undefined}
      className={cn("@container py-3.5", !last && "border-b border-line")}
    >
      <div
        className={cn(
          "flex flex-col gap-2.5",
          !wide && "@[560px]:grid @[560px]:grid-cols-[minmax(0,1fr)_auto] @[560px]:items-center @[560px]:gap-6",
        )}
      >
        <div className={cn("min-w-0 transition-opacity", disabled && "opacity-50")}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {dot && (
              <span
                className="inline-block size-[9px] shrink-0 rounded-full"
                style={{ background: dot }}
                title={dotTitle}
                aria-hidden
              />
            )}
            <span
              title={hint}
              className={cn(
                "min-w-0 text-text",
                hint && "cursor-help",
                env
                  ? "font-mono text-[12.5px] font-medium tracking-[0.01em] [overflow-wrap:anywhere]"
                  : "text-[14px] font-medium",
              )}
            >
              {title}
            </span>
            {overridden && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="overridden" />}
            {lockReason && (
              <span title={lockReason} className="inline-flex">
                <Lock className="size-3 shrink-0 text-faint" aria-hidden />
              </span>
            )}
            {lockReason && describedById && (
              <span id={describedById} className="sr-only">
                {lockReason}
              </span>
            )}
          </div>
          {desc && <div className="mt-0.5 max-w-[70ch] text-[12.5px] leading-snug text-dim">{desc}</div>}
        </div>
        <div className={cn("flex min-w-0 flex-col gap-1", !wide && "items-start @[560px]:items-end")}>
          {children}
          {(showClear || showReset) && (
            <div className="flex items-center gap-1">
              {showClear && (
                <button type="button" onClick={onClear} title={clearTitle} className={ACTION}>
                  <Eraser className="size-3" /> clear
                </button>
              )}
              {showReset && (
                <button type="button" onClick={onReset} title="Reset to inherited" className={ACTION}>
                  <RotateCcw className="size-3" /> reset
                </button>
              )}
            </div>
          )}
          {note && <div className="text-[11px] text-faint">{note}</div>}
        </div>
      </div>
    </div>
  );
}

/** A tri-state text override: undefined = inherit (the inherited value ghosted as placeholder),
 *  "" = the explicit empty override, anything else = the value. `escape` edits a value that may
 *  hold a line break or tab as `\n` / `\t` (escapeText). `rows` > 1 = a multi-line area. */
export function OverrideText({
  value,
  onChange,
  inherited,
  inheritWord,
  escape,
  rows,
  maxLength,
  fixedLabel,
  disabled,
  ariaLabel,
  describedBy,
  title,
  className,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  inherited?: string;
  inheritWord?: InheritWord;
  escape?: boolean;
  rows?: number;
  /** The longest stored value (characters); the escaped text in the field may be longer. */
  maxLength?: number;
  fixedLabel?: string;
  disabled?: boolean;
  ariaLabel: string;
  describedBy?: string;
  title?: string;
  className?: string;
}) {
  const shown = fixedLabel || value === undefined ? "" : escape ? escapeText(value) : value;
  const placeholder = overrideTextPlaceholder({ value, inherited, inheritWord, escape, fixedLabel });
  const commit = (raw: string) => {
    const v = escape ? unescapeText(raw) : raw;
    onChange(maxLength !== undefined ? Array.from(v).slice(0, maxLength).join("") : v);
  };
  const common = {
    "aria-label": ariaLabel,
    "aria-describedby": describedBy,
    title,
    disabled: disabled || !!fixedLabel,
    placeholder,
    spellCheck: false,
    className: cn(value !== undefined && !fixedLabel && "border-accent/55", className),
  };
  return rows && rows > 1 ? (
    <TextArea {...common} rows={rows} value={shown} onChange={(e) => commit(e.target.value)} />
  ) : (
    <TextInput {...common} value={shown} onChange={(e) => commit(e.target.value)} />
  );
}
