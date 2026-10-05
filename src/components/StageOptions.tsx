// A stage row's settings, folded (Transcribe's processing card): under the row's description,
// one quiet line names what the stage will run with ("Auto speakers · Default · community-1"),
// ending in a gear; the line toggles the settings panel below it. Closed by default; open, the
// panel takes the accent edge and the gear the accent. A value off its default puts the accent
// dot in the line, so a change shows while folded. Goes in SettingRow's `expand` slot.
import { useId, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { SettingExpand } from "@/components/ui";
import { cn } from "@/lib/cn";

export function StageOptions({
  summary,
  changed,
  label,
  children,
}: {
  /** What the stage runs with, one line (stageSummary.ts). */
  summary: string;
  /** A setting in the panel differs from its default. */
  changed?: boolean;
  /** The stage's name, for the toggle's accessible name ("Speaker diarization settings"). */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${label} settings: ${summary}`}
        title={summary}
        className="group ring-signal flex max-w-full items-center gap-1.5 rounded-md text-left text-[12px] text-faint hover:text-text"
      >
        {changed && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
        <span className="min-w-0 truncate">{summary}</span>
        <Settings
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-colors", open ? "text-accent" : "text-faint group-hover:text-text")}
        />
      </button>
      {open && (
        <SettingExpand id={panelId} open>
          {children}
        </SettingExpand>
      )}
    </div>
  );
}
