// Most-recently-used code lists (the pickers' "Recent" groups). Stored newest first; the
// pickers show the first few and update the list only when they close, so rows never move
// under the pointer.

import { useApp } from "./store";

/** How many recent picks are stored (the pickers show fewer). */
export const MAX_RECENT_STORED = 12;

/** `picked` (newest first) in front of the previous list, de-duplicated and capped. */
export function pushRecent(prev: readonly string[] | undefined, picked: readonly string[], max = MAX_RECENT_STORED): string[] {
  const head = [...new Set(picked)];
  return [...head, ...(prev ?? []).filter((c) => !head.includes(c))].slice(0, max);
}

/** A stored or seeded recent list made safe to render: strings of a sane length only,
 *  de-duplicated, capped. */
export function cleanRecent(v: unknown, max = MAX_RECENT_STORED): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c === "string" && c && c.length <= 64 && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Remember `picked` (newest first) in a settings recent list — the stored list cleaned
 *  first, since it may come from a synced or hand-edited config. */
export function rememberRecent(key: "recentSpokenLanguages" | "recentTranslationTargets", picked: readonly string[]): void {
  if (!picked.length) return;
  const st = useApp.getState();
  st.updateSettings({ [key]: pushRecent(cleanRecent(st.settings[key]), picked) });
}
