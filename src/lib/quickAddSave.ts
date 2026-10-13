// The quick-add window's verdict on one whole-map PATCH reply (QuickAdd.tsx flushSave). Pure, so
// the state each reply leads to is testable without mounting the standalone window.
import { envPinnedOf, saveLanded, RULE_LIST_SETTING } from "./pipelineMap";
import type { PipelineSaveResult } from "./types";

/** - "saved": the PATCH landed (a 2xx, readable or not).
 *  - "pinned": a 2xx, but the server's environment pins the rule list — nothing took effect.
 *  - "refused": 403 — the server will not take this map from this caller (an admin locked the
 *    list after the window loaded, or the account may not edit it). Like "pinned", a retry can
 *    never land, so it must not stay a retryable "error": the caller re-syncs instead, and the
 *    refresh's write gate then shows "List locked" / read-only.
 *  - "error": anything else (offline, 5xx, a 422) — worth retrying. A 401 stays here too: an
 *    expired or wrong key is fixable, and a re-sync would drop the unsaved addition. */
export type QuickAddSaveOutcome = "saved" | "pinned" | "refused" | "error";

export function quickAddSaveOutcome(res: PipelineSaveResult): QuickAddSaveOutcome {
  // `pinned` stays on res.ok — an unreadable 2xx reply names no pins.
  if (res.ok && envPinnedOf(res).includes(RULE_LIST_SETTING)) return "pinned";
  if (saveLanded(res)) return "saved";
  if (res.status === 403) return "refused";
  return "error";
}
