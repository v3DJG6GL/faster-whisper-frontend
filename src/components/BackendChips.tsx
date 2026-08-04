// Pill chips for choosing which backend a view is scoped to (e.g. whose usage
// statistics to show). Mirrors the Dictionary page's backend picker. With a single
// backend it renders one static name label — no pointless toggle; with several, an
// interactive selector (amber = active). Always shows the backend NAME, never the URL.
// The name is sync-authored and a rename raises no consent prompt, so it is defanged like
// every other remote-authored label: `truncate` bounds the WIDTH, not the bidi marks that
// let two servers render identically, and the `title` tooltip had no bound at all.

import { cn } from "@/lib/cn";
import { safeDisplayText } from "@/lib/sanitize";
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
  if (backends.length === 1) {
    return (
      <span
        className={cn(
          "max-w-[180px] truncate rounded-pill border border-line bg-surface-2 px-3 py-1 text-[12px] text-dim",
          className,
        )}
        title={safeDisplayText(backends[0].name, 80)}
      >
        {safeDisplayText(backends[0].name, 80)}
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
            title={safeDisplayText(b.name, 80)}
            className={cn(
              "ring-signal max-w-[180px] truncate rounded-pill border px-3 py-1 text-[12px] font-medium transition-colors",
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-line bg-surface-2 text-dim hover:text-text",
            )}
          >
            {safeDisplayText(b.name, 80)}
          </button>
        );
      })}
    </div>
  );
}
