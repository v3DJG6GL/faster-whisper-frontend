import {
  type ComponentProps, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { langCode, languageLabel } from "@/lib/languages";
import { POPOVER_PANEL } from "@/components/styles";
import { navKey } from "@/lib/listNav";
import { popoverBox, useAnchoredRect } from "@/lib/useAnchoredRect";
import { useOutsidePress } from "@/lib/useOutsidePress";

/* ── Button ───────────────────────────────────────────────────────────── */
type ButtonVariant = "default" | "accent" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

/** A Button's face, for the controls that draw one on a <button> of their own. `part` = one
 *  half of a SplitButton: the action (square right edge) or the chevron (square left edge, no
 *  side padding). Each class is chosen, never overridden — `cn` is clsx, not tailwind-merge. */
function buttonClass(variant: ButtonVariant, size: ButtonSize, part?: "action" | "chevron"): string {
  const sm = size === "sm";
  return cn(
    "ring-signal inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-40",
    part === "action" ? "rounded-l-xl" : part === "chevron" ? "rounded-r-xl" : "rounded-xl",
    sm ? "h-8 text-[12px]" : "h-10 text-[13px]",
    part === "chevron" ? (sm ? "w-7" : "w-8") : sm ? "px-3" : "px-4",
    variant === "accent" && "bg-accent text-accent-ink hover:brightness-110",
    variant === "default" && "border border-line-strong bg-surface-2 text-text hover:border-faint",
    // Transparent border at rest reserves the box, so hover/press only
    // recolor it — no layout shift when the outline appears.
    variant === "ghost" &&
      "border border-transparent text-dim hover:border-line-strong hover:bg-surface-2 hover:text-text active:border-faint",
    variant === "danger" && "border border-rec/40 text-rec hover:bg-rec/10",
  );
}

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
  variant?: ButtonVariant;
  size?: ButtonSize;
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
      className={cn(buttonClass(variant, size), className)}
    >
      {children}
    </button>
  );
}

/* ── SplitButton ──────────────────────────────────────────────────────── */
/** One on/off option in a SplitButton's menu. */
export interface MenuCheck {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  title?: string;
}

/** A Button with a chevron beside it that opens a menu of on/off options for the same action
 *  (role="menu" of menuitemcheckbox rows, portaled like ListPicker's popover). ↑↓ on the
 *  chevron opens it; in the menu ↑↓ move, Space ticks, Enter ticks and closes, Esc closes back
 *  to the chevron; Tab and a click outside just close. */
export function SplitButton({
  children,
  onClick,
  variant = "accent",
  size = "md",
  disabled,
  title,
  menuLabel,
  options,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  title?: string;
  /** The chevron's accessible name and tooltip, and the menu's name. */
  menuLabel: string;
  options: MenuCheck[];
}) {
  const menuId = `${useId()}-menu`;
  const itemId = (i: number) => `${menuId}-${i}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = useAnchoredRect(wrapRef, open);
  const placed = open && rect !== null;
  // Roving focus: the active row holds it while the menu is up.
  useEffect(() => {
    if (placed) document.getElementById(`${menuId}-${active}`)?.focus({ preventScroll: true });
  }, [placed, active, menuId]);
  useOutsidePress([menuRef, chevronRef], open, () => setOpen(false));

  const show = (at: number) => {
    if (disabled || !options.length) return;
    setActive(at);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chevronRef.current?.focus();
  };
  const tick = (i: number) => {
    const o = options[i];
    if (o) o.onChange(!o.checked);
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const next = navKey(e.key, active, options.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === " ") {
      e.preventDefault();
      tick(active);
    } else if (e.key === "Enter") {
      e.preventDefault();
      tick(active);
      close(true);
    } else if (e.key === "Escape") {
      // Ours alone, like ListPicker's: a dialog behind the menu must not take this Esc.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div ref={wrapRef} className="inline-flex">
      <button type="button" onClick={onClick} disabled={disabled} title={title} className={buttonClass(variant, size, "action")}>
        {children}
      </button>
      <button
        ref={chevronRef}
        type="button"
        disabled={disabled}
        aria-label={menuLabel}
        title={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show(0))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show(e.key === "ArrowUp" ? options.length - 1 : 0);
          }
        }}
        className={cn(
          buttonClass(variant, size, "chevron"),
          // The seam between the halves: a hairline in the face's own ink.
          variant === "accent" ? "border-l border-accent-ink/20" : "-ml-px",
        )}
      >
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={menuLabel}
            style={popoverBox(rect, { minWidth: 220, minRoom: 120, align: "end" }).style}
            className={cn(POPOVER_PANEL, "p-1.5")}
            onKeyDown={onMenuKey}
          >
            {options.map((o, i) => (
              <div
                key={o.label}
                id={itemId(i)}
                role="menuitemcheckbox"
                aria-checked={o.checked}
                tabIndex={i === active ? 0 : -1}
                title={o.title}
                onClick={() => {
                  setActive(i);
                  tick(i);
                  close(true);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-text outline-none",
                  "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-[1.5px] focus-visible:ring-inset focus-visible:ring-accent",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {o.checked && <Check className="size-3.5 text-accent" />}
                </span>
                <span className="min-w-0 flex-1 whitespace-nowrap">{o.label}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
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
 *  outlines it in the accent while its list is up; `sm` = a table row's compact field;
 *  `muted` dims an md value (a className can't: cn doesn't merge, and text-text wins). */
export function FieldTrigger({
  open,
  size = "md",
  muted,
  className,
  children,
  ...rest
}: ComponentProps<"button"> & { open?: boolean; size?: "sm" | "md"; muted?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "ring-signal flex w-full items-center justify-between gap-2 border border-line bg-surface-2 text-left",
        size === "md"
          ? `h-10 rounded-xl pl-3.5 pr-3 text-[13px] ${muted ? "text-dim" : "text-text"}`
          : "h-8 rounded-lg px-2.5 text-[12.5px] text-dim",
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
