// The shortcut-capture control shared by every rebind surface (the Profiles editor
// and the Settings quick-add row) so they look and behave identically. It shows the
// bound chord as <kbd> chips, flips to a live "press your shortcut" pill while
// capturing (held modifiers + a trailing …, with an inline hint or conflict
// warning), and renders the Set / Change / Cancel toggle plus an optional Clear.
//
// This is purely presentation — the capture logic (held-modifier tracking, conflict
// checks, suspend/reregister) lives in useHotkeyCapture, which the parent drives.

import { Keyboard } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { HotkeyChips } from "@/components/HotkeyChips";
import { codesToLabels } from "@/lib/keys";
import { cn } from "@/lib/cn";

export function HotkeyCaptureControl({
  codes,
  capturing,
  heldCodes,
  warn,
  onToggle,
  onClear,
}: {
  /** The currently-bound chord (event.code list); [] when unset. */
  codes: string[];
  /** Whether a capture is in progress (the parent owns the boolean). */
  capturing: boolean;
  /** Live state from useHotkeyCapture: modifiers held so far + a conflict/hint warning. */
  heldCodes: string[];
  warn: string | null;
  /** Toggle capturing on/off. */
  onToggle: () => void;
  /** Clear the binding. Omit to hide the Clear button entirely. */
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {capturing ? (
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-xl border border-accent/60 bg-accent-soft/40 px-3 py-1.5 ring-2 ring-accent/25">
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="inline-flex flex-wrap items-center gap-1">
            {codesToLabels(heldCodes).map((k, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 && <span className="text-faint">+</span>}
                <Kbd>{k}</Kbd>
              </span>
            ))}
            {heldCodes.length > 0 && <span className="text-faint">+</span>}
            <Kbd>…</Kbd>
          </span>
          <span className={cn("ml-1 text-[12px]", warn ? "text-rec" : "text-dim")}>
            {warn ?? "Press your shortcut · Esc to cancel"}
          </span>
        </div>
      ) : (
        <div className="flex flex-1 items-center">
          <HotkeyChips codes={codes} />
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={onToggle}>
        <Keyboard className="size-4" /> {capturing ? "Cancel" : codes.length ? "Change" : "Set"}
      </Button>
      {onClear && codes.length > 0 && !capturing && (
        <Button variant="ghost" size="sm" title="Clear shortcut" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  );
}
