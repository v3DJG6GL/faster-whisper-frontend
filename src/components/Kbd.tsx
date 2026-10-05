// The keycap. Its own module so ListPicker can use it without importing ui.tsx, which
// imports ListPicker (ui.tsx re-exports it for everyone else).
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** `md` = a key on its own; `sm` / `xs` = a key inside a hint line (QuickAdd's footer, a
 *  picker's keys). */
export function Kbd({ size = "md", children }: { size?: "md" | "sm" | "xs"; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "border border-line-strong bg-surface-2 font-mono",
        size === "md"
          ? "inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-[12px] text-text shadow-[0_1px_0_var(--c-line-strong)]"
          : "rounded-md px-1.5 py-0.5 leading-none text-dim",
        size === "sm" && "text-[11px]",
        size === "xs" && "text-[10.5px]",
      )}
    >
      {children}
    </kbd>
  );
}
