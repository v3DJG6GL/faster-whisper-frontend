import { type ReactNode, type ReactElement, cloneElement, isValidElement, useEffect, useId, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/buttons";
import { Segmented, Select, Toggle } from "@/components/ui/form";

export function Card({
  className,
  edge,
  faint,
  children,
}: {
  className?: string;
  /** The border colour. A choice, not a className override: cn is clsx (no merge) and the built
   *  CSS emits border-line after most border colours, so an appended one would lose. */
  edge?: "accent" | "warn" | "strong";
  /** A faded backdrop (bg-surface/40) instead of the solid one — same reason. */
  faint?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-card border backdrop-blur-sm",
        edge === "accent"
          ? "border-accent/40"
          : edge === "warn"
            ? "border-warn/40"
            : edge === "strong"
              ? "border-line-strong"
              : "border-line",
        faint ? "bg-surface/40" : "bg-surface/80",
        className,
      )}
    >
      {children}
    </div>
  );
}

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

/**
 * The header of a full-page editor (Profiles / Backends / Per-app rules), where
 * the editor REPLACES the list it came from.
 *
 * It pins to the top of the scroll container because these forms run past a
 * screen height, so a way out stays in reach. It names what you're editing (the
 * page header behind it still says "Profiles") and shows whether there is
 * unsaved work. The bottom Save/Cancel pair stays where the form finishes; this
 * only adds a way out from the top.
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
  const panelRef = useRef<HTMLDivElement>(null);
  // A modal takes the focus: left in the editor field behind the backdrop, keystrokes would keep
  // editing the draft the dialog calls frozen (and Enter re-fire the button that opened it). The
  // safe answer gets it; on close it goes back to where it was if that is still there (Keep
  // editing), not after Discard / Save and leave unmounted the editor.
  useEffect(() => {
    const saved = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      if (saved?.isConnected) saved.focus({ preventScroll: true });
    };
  }, []);
  // Esc keeps you here: the destructive answer is never the reflex one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onStay();
      } else if (e.key === "Tab" && panelRef.current) {
        // Tab cycles the three answers: it never walks out into the editor behind the backdrop.
        const btns = Array.from(panelRef.current.querySelectorAll("button"));
        if (!btns.length) return;
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.shiftKey ? (i <= 0 ? btns[btns.length - 1] : null) : i === -1 || i === btns.length - 1 ? btns[0] : null;
        if (to) {
          e.preventDefault();
          to.focus();
        }
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
      <div ref={panelRef} className="w-full max-w-[420px]" onClick={(e) => e.stopPropagation()}>
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
        aria-controls={open ? panelId : undefined} // the panel node exists only while open; never point at a missing id
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

// A Stack owns the vertical gap between its children so they stay margin-free; `gap`
// (not `space-y`) avoids margin-collapse and first/last-child leaks. Inner gaps ≤ outer
// ones. Opt-in per container, not a global default, so existing tuned screens are unaffected.
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
  /** WHY this row is inactive, shown at full contrast IN PLACE OF `desc`: a dimmed row
   *  alone never tells the reader what would make it available. Greying stays (Microsoft
   *  and GNOME guidance prefer insensitive over hidden for "available once a condition is
   *  met"). Two sentences: the condition, then how to change it. Not dimmed with the row —
   *  WCAG's contrast exemption for inactive controls makes a dim reason conformant but useless. */
  disabledReason?: string;
  /** Sub-panel rendered INSIDE the row, below the header flex line — the
   *  row's border-b stays underneath it, so an expanded row reads as one
   *  unit instead of the panel floating between two rows. */
  expand?: ReactNode;
}) {
  // A Toggle, Select or Segmented has no accessible name here (the title is a sibling <div>, not
  // a <label htmlFor>), so a DIRECT child of those types gets the row title. A control wrapped in
  // its own <div> (the mic select with its Refresh button) is not direct and passes ariaLabel itself.
  const control =
    isValidElement(children) &&
    (children.type === Toggle || children.type === Select || children.type === Segmented)
      ? cloneElement(children as ReactElement<{ ariaLabel?: string }>, {
          ariaLabel: (children.props as { ariaLabel?: string }).ariaLabel ?? title,
        })
      : children;
  // Grid with a capped control column, not flex: in flex a wide Segmented starves the
  // description at any page width. A CONTAINER query on the row, not a viewport breakpoint:
  // the row sits both in Settings' full-width cards and in the Transcribe studio's 420px rail.
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
