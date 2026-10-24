// A stage row's folded settings (Transcribe's processing card): a gear beside the row's switch
// and one quiet line under its description naming what the stage will run with ("Auto speakers
// · Default · community-1") both toggle the panel; an accent dot in the line shows a value off
// its default while folded.
//
// The gear sits in SettingRow's control column and the panel in its `expand` slot, so the
// two share one `useStageOptions()` state.
import { useId, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { SettingExpand } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface StageOptionsState {
  open: boolean;
  toggle: () => void;
  panelId: string;
}

export function useStageOptions(): StageOptionsState {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return { open, toggle: () => setOpen((v) => !v), panelId };
}

/** The gear beside a stage's switch, sized to the switch. Always shown: while the stage is off
 *  (or has nothing to set) it greys out and its tooltip says why, so the row never shifts. */
export function StageGear({
  state,
  label,
  disabled,
  disabledReason,
}: {
  state: StageOptionsState;
  label: string;
  disabled?: boolean;
  /** The tooltip while disabled. */
  disabledReason?: string;
}) {
  const open = state.open && !disabled;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : state.toggle}
      aria-disabled={disabled || undefined}
      aria-expanded={disabled ? undefined : open}
      aria-controls={open ? state.panelId : undefined}
      aria-label={`${label} settings`}
      title={disabled ? (disabledReason ?? `${label} settings`) : `${label} settings`}
      className={cn(
        "ring-signal grid size-[30px] shrink-0 place-items-center rounded-lg transition-colors",
        disabled ? "cursor-not-allowed text-faint opacity-40" : open ? "text-accent" : "text-dim hover:text-text",
      )}
    >
      <Settings aria-hidden className="size-5" />
    </button>
  );
}

export function StageOptions({
  state,
  summary,
  changed,
  label,
  children,
}: {
  state: StageOptionsState;
  /** What the stage runs with, one line (stageSummary.ts). */
  summary: string;
  /** A setting in the panel differs from its default. */
  changed?: boolean;
  /** The stage's name, for the line's accessible name ("Speaker diarization settings"). */
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={state.toggle}
        aria-expanded={state.open}
        aria-controls={state.open ? state.panelId : undefined}
        aria-label={`${label} settings: ${summary}`}
        title={summary}
        className="ring-signal flex max-w-full items-center gap-1.5 rounded-md text-left text-[12px] text-faint hover:text-text"
      >
        {changed && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      {state.open && (
        <SettingExpand id={state.panelId} open>
          {children}
        </SettingExpand>
      )}
    </div>
  );
}
