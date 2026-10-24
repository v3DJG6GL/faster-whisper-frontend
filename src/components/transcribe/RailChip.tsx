import { type ReactNode } from "react";

/** A run-rail receipt chip: an optional bold metric, then plain words. */
export function RailChip({ value, children }: { value?: ReactNode; children?: ReactNode }) {
  return (
    <span className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-dim">
      {value != null && <span className="font-medium text-text">{value}</span>}
      {children}
    </span>
  );
}

/** A rail row name's quiet " — phase" suffix ("Transcribe — analyzing audio…"). */
export function RailSuffix({ children }: { children: ReactNode }) {
  return <span className="font-normal text-faint"> — {children}</span>;
}
