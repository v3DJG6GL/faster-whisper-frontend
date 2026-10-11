// The pieces of a dictation route (`source → targets`) as RouteBadge (components/ui/feedback.tsx)
// and the Dashboard readout show them: language labels, each part bounded, the list capped.

import { languageLabel } from "./languages";
import { safeDisplayText } from "./sanitize";

// How many targets are spelled out before the rest become "+N". Three is what fits
// beside a profile's name, model and endpoint badges without wrapping the row.
export const ROUTE_TARGETS_SHOWN = 3;

// ZWNJ/ZWJ render as nothing yet survive both trim and the display filter, so they go before the
// trim — as langCode drops them — or a joiner-only code would show as a blank slot.
const noJoin = (s: string): string => s.replace(/[\u200c\u200d]/g, "");

/** The pieces of a `source → targets` route, bounded for display.
 *
 *  Pure + exported so it can be tested: every part is user- or peer-authored (a
 *  profile's language, a synced backend's, the translate-to list), and
 *  `languageLabel` passes an unknown code through unchanged — the same unbounded-leaf
 *  hazard the badge's own truncate exists for, except a LIST of them multiplies it. */
export function routeParts(
  source: string,
  targets?: string[] | null,
): { source: string; targets: string[]; more: number } {
  // Array.isArray, not `?? []`: a record read back from disk can carry a string here.
  const labels = (Array.isArray(targets) ? targets : [])
    .map((t) => (typeof t === "string" ? noJoin(t).trim() : ""))
    .filter(Boolean)
    // Filtered again after the sanitize: a code made only of invisible format characters
    // trims to something, then sanitizes to nothing, and would show as a blank slot.
    .map((t) => safeDisplayText(languageLabel(t), 24).trim())
    .filter(Boolean);
  // The source gets the same trim-then-recheck, but a SET one that sanitizes blank (whitespace,
  // joiners or format characters only) is still sent — Rust's wire_language passes any non-empty
  // code — so it reads "??", as routeSourceCode does. Only an empty one comes back "" for the readers'
  // `|| "auto"` fallback; "auto" itself labels as "Auto-detect", and a padded " de" still finds
  // its label.
  const raw = typeof source === "string" ? source : "";
  const src = noJoin(raw).trim();
  const label = src ? safeDisplayText(languageLabel(src), 24).trim() : "";
  return {
    source: label || (raw && raw !== "auto" ? "??" : ""),
    targets: labels.slice(0, ROUTE_TARGETS_SHOWN),
    more: Math.max(0, labels.length - ROUTE_TARGETS_SHOWN),
  };
}
