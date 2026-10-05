import { type ReactNode, type ReactElement, cloneElement, isValidElement, useEffect, useId } from "react";
import type { LucideIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/buttons";
import { Select, Toggle } from "@/components/ui/form";

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
