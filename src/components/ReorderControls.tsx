// A compact vertical up/down reorder control — drag-free and keyboard-accessible,
// matching the arrow-button pattern used in the Dictionary rule list. Used to reorder
// profiles and backends in their lists.

import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function ReorderControls({
  canUp,
  canDown,
  onUp,
  onDown,
  className,
}: {
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-col text-faint", className)}>
      <button
        type="button"
        title="Move up"
        aria-label="Move up"
        disabled={!canUp}
        onClick={onUp}
        className="ring-signal grid size-5 place-items-center rounded-md transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        title="Move down"
        aria-label="Move down"
        disabled={!canDown}
        onClick={onDown}
        className="ring-signal grid size-5 place-items-center rounded-md transition-colors hover:text-text disabled:pointer-events-none disabled:opacity-25"
      >
        <ChevronDown className="size-4" />
      </button>
    </div>
  );
}
