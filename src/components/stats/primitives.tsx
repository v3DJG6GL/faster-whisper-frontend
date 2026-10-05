import { type ReactNode } from "react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/cn";
import { KIND_VAR } from "@/lib/usageDerive";
import type { UsageKind } from "@/lib/types";

/** The diagonal hatch the Text series is drawn in (neutral, never a volume story). */
export function HatchDef({ id }: { id: string }) {
  return (
    <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4" height="4" fill="var(--c-surface-2)" />
      <rect width="1.6" height="4" fill="var(--c-chart-text)" />
    </pattern>
  );
}

/** Legend swatch: a solid square, or the hatch for Text. */
export function Swatch({ kind }: { kind: UsageKind }) {
  return (
    <i
      className="inline-block size-2.5 rounded-[3px]"
      style={
        kind === "text"
          ? { background: "repeating-linear-gradient(45deg, var(--c-chart-text) 0 2px, transparent 2px 4px)" }
          : { background: KIND_VAR[kind] }
      }
    />
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] uppercase tracking-label text-faint", className)}>{children}</span>;
}

export function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-pill border border-line px-2.5 py-0.5 font-mono text-[11px] text-dim">{children}</span>
  );
}

/** A panel card with the mockup's header row: eyebrow · spacer · right slot. */
export function Panel({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("mt-3.5 px-4 pb-3 pt-3.5", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <Eyebrow>{title}</Eyebrow>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </Card>
  );
}
export const Num = ({ children }: { children: ReactNode }) => <span className="font-num text-text">{children}</span>;
