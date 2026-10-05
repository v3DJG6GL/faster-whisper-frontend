// A stage row's settings, folded (Transcribe's processing card): a gear beside the row's
// switch opens them, and under the row's description one quiet line names what the stage
// will run with ("Auto speakers · Default · community-1") — the line toggles too. Closed by
// default; open, the panel takes the accent edge and the gear the accent. A value off its
// default puts the accent dot in the line, so a change shows while folded.
//
// The gear sits in SettingRow's control column and the panel in its `expand` slot, so the
// two share one `useStageOptions()` state: <StageGear> beside the switch, <StageOptions> in
// `expand`.
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

/** The gear beside a stage's switch. */
export function StageGear({ state, label }: { state: StageOptionsState; label: string }) {
  return (
    <button
      type="button"
      onClick={state.toggle}
      aria-expanded={state.open}
      aria-controls={state.open ? state.panelId : undefined}
      aria-label={`${label} settings`}
      title={`${label} settings`}
      className={cn(
        "ring-signal grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
        state.open ? "text-accent" : "text-faint hover:text-text",
      )}
    >
      <Settings aria-hidden className="size-4" />
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
