// Pill chips for choosing which backend a view is scoped to (e.g. whose usage
// statistics to show). With a single backend it renders one static name label — no
// pointless toggle; with several, an interactive selector (amber = active). Always
// shows the backend NAME, never the URL. Labels come from `backendOptions`, the same
// resolver every other backend picker uses: identity-safe text (invisible and bidi
// code points removed, not just width-truncated) plus a collision suffix, so two
// backends whose names draw identically are still told apart here too.

import { backendOptions } from "@/lib/backends";
import { cn } from "@/lib/cn";
import type { Backend } from "@/lib/types";

export function BackendChips({
  backends,
  selectedId,
  onSelect,
  className,
}: {
  backends: Backend[];
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (backends.length === 0) return null;
  // One pass for the whole list — the collision suffix needs every name at once.
  const labels = new Map(backendOptions(backends).map((o) => [o.value, o.label]));
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
