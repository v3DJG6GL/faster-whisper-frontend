// The pieces of a dictation route (`source → targets`) as RouteBadge (components/ui/feedback.tsx)
// and the Dashboard readout show them: language labels, each part bounded, the list capped.

import { languageLabel } from "./languages";
import { safeDisplayText } from "./sanitize";

// How many targets are spelled out before the rest become "+N". Three is what fits
// beside a profile's name, model and endpoint badges without wrapping the row.
export const ROUTE_TARGETS_SHOWN = 3;

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
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    // Filtered again after the sanitize: a code made only of invisible format characters
    // trims to something, then sanitizes to nothing, and would show as a blank slot.
    .map((t) => safeDisplayText(languageLabel(t), 24).trim())
    .filter(Boolean);
  return {
    source: safeDisplayText(languageLabel(source), 24),
    targets: labels.slice(0, ROUTE_TARGETS_SHOWN),
    more: Math.max(0, labels.length - ROUTE_TARGETS_SHOWN),
  };
}
