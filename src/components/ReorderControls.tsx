// A compact vertical up/down reorder control — drag-free and keyboard-accessible,
// matching the arrow-button pattern used in the Dictionary rule list. Used to reorder
// profiles and backends in their lists.

import { useLayoutEffect, useRef } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const ARROW =
  "ring-signal grid size-5 place-items-center rounded-md transition-colors hover:text-text aria-disabled:pointer-events-none aria-disabled:opacity-25";

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
  // Keyboard focus must survive a move. A pressed arrow that becomes disabled (the row reached the
  // top or bottom) drops focus to <body>, so the arrows use aria-disabled; and a keyed list moves a
  // row's DOM node to move it down, which blurs its focused button — so the arrow pressed last is
  // focused again after the list re-renders, when focus fell to <body>.
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef<"up" | "down" | null>(null);
  useLayoutEffect(() => {
    const which = pressed.current;
    if (!which) return;
    pressed.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) (which === "up" ? upRef : downRef).current?.focus();
  });

  return (
    <div className={cn("flex shrink-0 flex-col text-faint", className)}>
      <button
        ref={upRef}
        type="button"
        title="Move up"
        aria-label="Move up"
        aria-disabled={!canUp}
        onClick={() => {
          if (!canUp) return;
          pressed.current = "up";
          onUp();
        }}
        className={ARROW}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        ref={downRef}
        type="button"
        title="Move down"
        aria-label="Move down"
        aria-disabled={!canDown}
        onClick={() => {
          if (!canDown) return;
          pressed.current = "down";
          onDown();
        }}
        className={ARROW}
      >
        <ChevronDown className="size-4" />
      </button>
    </div>
  );
}
