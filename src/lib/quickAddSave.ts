// The quick-add window's verdict on one whole-map PATCH reply (QuickAdd.tsx flushSave), the
// list and address it sends that PATCH to, and the edge whitespace its correct-on-close puts
// back around the corrected word. Pure, so each is testable without mounting the standalone
// window.
import { effectiveServerUrl, serverUrlFromPeer } from "./backends";
import { envPinnedOf, saveLanded, RULE_LIST_SETTING } from "./pipelineMap";
import type { AppSettings, Backend, Config, PipelineSaveResult } from "./types";

/** Where quick-add connects for `backend`, read straight from config.json (this window has no
 *  store). The main store canonicalises an older build's address on load (wellFormedBackends)
 *  but never writes that back, so the file can still hold a schemeless `nas.lan:8000` that the
 *  main window sends as `http://nas.lan:8000` — and the Rust transport, which only trims, would
 *  refuse here. The same canonicalisation, so both windows send one address. */
export function quickAddServerUrl(backend: Backend, settings: AppSettings): string {
  const serverUrl = serverUrlFromPeer(backend.serverUrl) || backend.serverUrl;
  return effectiveServerUrl(serverUrl === backend.serverUrl ? backend : { ...backend, serverUrl }, settings);
}

/** The list quick-add PATCHes: the pinned slug on its backend, at that backend's address.
 *  `backendUrl` is the backend's own Server URL (canonical, without this device's address
 *  override) that the window's rows were loaded under — what quickAddTargetMoved tells a
 *  different server by. Only a load (refresh) sets it — and keeps it too while this device's
 *  address override is in force; a summon always keeps it. */
export type QuickAddSaveTarget = { serverUrl: string; backendUrl: string; backendId: string; slug: string };

/** The save target `cfg` pins, or null when nothing is pinned or the pin names a backend the file
 *  no longer has (removing a backend nulls the pin, but either way there is nothing to save to). */
export function quickAddTargetOf(cfg: Config | null): QuickAddSaveTarget | null {
  const pin = cfg?.settings.quickAddList ?? null;
  const backend = pin ? cfg!.backends.find((b) => b.id === pin.backendId) ?? null : null;
  if (!pin || !backend) return null;
  return {
    serverUrl: quickAddServerUrl(backend, cfg!.settings),
    backendUrl: serverUrlFromPeer(backend.serverUrl) || backend.serverUrl,
    backendId: backend.id,
    slug: pin.slug,
  };
}

/** The target a load (refresh) fetches the rows from. A reload of the same list keeps
 *  `prev.backendUrl` whenever this device's address override is in force after the reload,
 *  whether that override is new, at a new address or unchanged: the rows came through the
 *  override, so a Server URL edit it masks is not where they came from (an override
 *  added or re-addressed alongside it proves nothing either way — the summon already treats that
 *  pair as a possible move). Recorded instead, a later summon that drops the override would pass
 *  as no move, and its retry would replace that other server's list of the same name with this
 *  one's whole map. Kept, a real move merely counts as one later and drops the pending rows.
 *  Without an override the reload fetched the rows from the file's own Server URL, so that is
 *  recorded, even at the address `prev` reached through an override: kept, the older URL turned
 *  the "Address on this device" that recovers a failed save into a move. */
export function quickAddTargetOnLoad(prev: QuickAddSaveTarget | null, cfg: Config | null): QuickAddSaveTarget | null {
  const next = quickAddTargetOf(cfg);
  if (!prev || !next || next.backendId !== prev.backendId || next.slug !== prev.slug) return next;
  // serverUrl differs from backendUrl only while an override replaces the Server URL.
  const overriddenNow = next.serverUrl !== next.backendUrl;
  return overriddenNow ? { ...next, backendUrl: prev.backendUrl } : next;
}

/** Has the pin moved off `current` (another list, another backend, another server, or
 *  unpinned)? The window's unsaved rows belong to `current`, so once it has they are no longer
 *  worth keeping over a re-sync. A new "Address on this device" alone is no move: it is the same
 *  list on the same server, reached another way. An edited Server URL is one — it may name a
 *  different server (the main store drops a re-addressed backend's connection as describing the
 *  OLD server), and retrying there would replace that server's list of the same name with this
 *  one's whole map — unless this device's address override still sends the save where it was
 *  going, where a retry reaches the very list the rows came from. No `current` (nothing loaded
 *  yet) is never a move. */
export function quickAddTargetMoved(current: QuickAddSaveTarget | null, cfg: Config | null): boolean {
  if (!current) return false;
  const next = quickAddTargetOf(cfg);
  return (
    !next ||
    next.backendId !== current.backendId ||
    next.slug !== current.slug ||
    (next.backendUrl !== current.backendUrl && next.serverUrl !== current.serverUrl)
  );
}

/** A summon's read of the pin against `current`, the list the window's rows belong to. Unless it
 *  moved, `target` is `current` at the address the file names now: an unreachable address is the
 *  usual reason a save is pending, and the user fixes it by adding (or changing) this device's
 *  address, so the pending save must follow the list there, not retry the old one. It keeps
 *  `current.backendUrl`, though: adopting an edited Server URL that the override still masked
 *  would let a later summon without the override pass as no move, and two accepted summons
 *  would add up to the very move one summon is refused. */
export function quickAddTargetOnSummon(
  current: QuickAddSaveTarget | null,
  cfg: Config | null,
): { moved: boolean; target: QuickAddSaveTarget | null } {
  if (quickAddTargetMoved(current, cfg)) return { moved: true, target: current };
  const next = quickAddTargetOf(cfg);
  return { moved: false, target: current && next && { ...next, backendUrl: current.backendUrl } };
}

/** - "saved": the PATCH landed (a 2xx, readable or not).
 *  - "pinned": a 2xx, but the server's environment pins the rule list — nothing took effect.
 *  - "refused": the server will never take this map's rule from this caller, by its own words:
 *    a 403 naming a lock ("rule '…' is locked and cannot be edited", "the terminal rule cannot
 *    be edited", "rule '…' is not visible to your user": an admin locked the list after the
 *    window loaded), a 403 "no access to /quick-config" (an admin revoked this caller's
 *    quick_config page), a 400 "unknown rule slug" (the pinned list was deleted, or hidden from
 *    this user; the server folds both into that one 400) or a 400 "field 'map' is not editable on
 *    rule '…'" (an admin changed the pinned rule's type away from a map). Like "pinned", a retry
 *    can never land, so the caller re-syncs instead, and the refresh's write gate then shows
 *    "List locked" / read-only or the "re-pin one in the Dictionary" page.
 *  - "rejected": the server refuses something IN the rows — a 422 (a phrase outside the word-list
 *    pattern, an over-long value) or a 400 dictionary cap ("this dictionary is full", "too many
 *    dictionary entries"). Re-sending the same rows can never land, so it is not auto-retried; but
 *    the rows are the user's to fix (delete one), so unlike "refused" they are kept (no re-sync):
 *    the next edit sends them again. quickAddRejectReason says what the server named.
 *  - "error": anything else — worth retrying, and the user's rows are kept. That includes a 403
 *    that names no lock (a WAF blocking the PATCH body but not the GET: a re-sync would pass the
 *    write gate and silently replace the unsaved rows), a 5xx, offline, and a 401 (an expired or
 *    wrong key is fixable). */
export type QuickAddSaveOutcome = "saved" | "pinned" | "refused" | "rejected" | "error";

/** The quick_config PATCH's refusal texts for a rule this caller may not edit (403). */
const LOCK_REFUSAL = /^(?:rule '.*' is locked and cannot be edited|the terminal rule cannot be edited|rule '.*' is not visible to your user)/;
/** require_page("quick_config")'s 403 once an admin sets this caller's quick_config scope to none. */
const PAGE_REFUSAL = /^no access to \/quick-config$/;
/** …for a slug the server no longer has, or no longer shows this caller, and for a rule whose
 *  type no longer takes a `map` (400). */
const GONE_RULE = /^(?:unknown rule slug\b|field '.*' is not editable on rule ')/;
/** …for a map over the server's entry cap (400, ahead of any validation). */
const MAP_CAP = /^(?:this dictionary is full\b|too many dictionary entries\b)/;

export function quickAddSaveOutcome(res: PipelineSaveResult): QuickAddSaveOutcome {
  // `pinned` stays on res.ok — an unreadable 2xx reply names no pins.
  if (res.ok && envPinnedOf(res).includes(RULE_LIST_SETTING)) return "pinned";
  if (saveLanded(res)) return "saved";
  const detail = typeof res.detail === "string" ? res.detail.trim() : "";
  if (res.status === 403 && (LOCK_REFUSAL.test(detail) || PAGE_REFUSAL.test(detail))) return "refused";
  if (res.status === 400 && GONE_RULE.test(detail)) return "refused";
  if (res.status === 422 || (res.status === 400 && MAP_CAP.test(detail))) return "rejected";
  return "error";
}

/** What a "rejected" (422 or 400 cap) reply names as the problem — the server's first validation message,
 *  else its detail — for the save badge. Opaque server JSON, so coerced and bounded. */
export function quickAddRejectReason(res: PipelineSaveResult): string {
  const first = Array.isArray(res.errors) ? res.errors.find((e) => typeof e?.msg === "string" && e.msg.trim()) : undefined;
  const text = first?.msg ?? (typeof res.detail === "string" ? res.detail : "");
  return text.trim().slice(0, 200) || "The server refused a mapping in this list.";
}

/** The edge characters the typing route may carry back: a space, tab or no-break space. A line
 *  break is not one — typing would turn it into a real Enter. */
const TYPED_EDGE = " \t\u00a0";

/** The leading and trailing whitespace of `current`, the live selection correct-on-close
 *  replaces (QuickAdd.tsx replaceSelectionAfterClose): any whitespace on a paste / clipboard
 *  route, only spaces, tabs and no-break spaces when `typed`. Plain scans, not a `$`-anchored
 *  `/\s*$/`: that one retries at every position of a blank run that something follows, which is
 *  quadratic, and the re-read selection is up to 64K characters (focus/mod.rs SEL_MAX) of
 *  whatever the user selected meanwhile — seconds of a frozen window on a padded terminal
 *  region. trimStart / trimEnd strip exactly `\s`'s set (WhiteSpace and LineTerminator). An
 *  all-blank `current` is both edges at once, as the regexes had it. */
export function selectionEdges(current: string, typed: boolean): { lead: string; trail: string } {
  if (!typed) {
    return { lead: current.slice(0, current.length - current.trimStart().length), trail: current.slice(current.trimEnd().length) };
  }
  let start = 0;
  while (start < current.length && TYPED_EDGE.includes(current[start])) start++;
  let end = current.length;
  while (end > 0 && TYPED_EDGE.includes(current[end - 1])) end--;
  return { lead: current.slice(0, start), trail: current.slice(end) };
}
