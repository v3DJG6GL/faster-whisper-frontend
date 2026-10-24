// Pill chips for choosing which backend a view is scoped to (e.g. whose usage statistics to
// show); a single backend gets a static label, not a pointless toggle. Always the backend NAME,
// never the URL. Labels come from `backendLabels` over the FULL configured list (`labelsFrom`),
// as in every other backend picker, so a chip carries the same collision suffix the pickers
// show even when its look-alike twin is not among the chips (no statistics).

import { backendLabels } from "@/lib/backends";
import { cn } from "@/lib/cn";
import type { Backend } from "@/lib/types";

export function BackendChips({
  backends,
  labelsFrom,
  selectedId,
  onSelect,
  className,
}: {
  backends: Backend[];
  /** The list the labels are resolved over — the store's whole backend list when `backends`
   *  is a subset of it. Defaults to `backends`. */
  labelsFrom?: Backend[];
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (backends.length === 0) return null;
  // One pass for the whole list — the collision suffix needs every name at once.
  const labels = backendLabels(labelsFrom ?? backends);
  const labelOf = (b: Backend) => labels.get(b.id) ?? "";
  if (backends.length === 1) {
    return (
      <span
        className={cn(
          "max-w-[180px] truncate rounded-pill border border-line bg-surface-2 px-3 py-1 text-[12px] text-dim",
          className,
        )}
        title={labelOf(backends[0])}
      >
        {labelOf(backends[0])}
      </span>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {backends.map((b) => {
        const active = b.id === selectedId;
        return (
          <button
            key={b.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(b.id)}
            title={labelOf(b)}
            className={cn(
              "ring-signal max-w-[180px] truncate rounded-pill border px-3 py-1 text-[12px] font-medium transition-colors",
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-surface-2 text-dim hover:text-text",
            )}
          >
            {labelOf(b)}
          </button>
        );
      })}
    </div>
  );
}
