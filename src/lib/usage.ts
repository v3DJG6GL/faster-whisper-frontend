// Usage-stats controller (runs in the main window). Keeps the active backend's
// usage (GET /v1/usage) fresh in the store so BOTH the Home stats section
// (React) and the chip readout (the separate overlay webview, fed via
// chipController.ts) can read it. Like chipController.ts it's a store-subscribed singleton.
//
// Two documents per backend: a FIXED 30-day one for the Home strip and the chip
// (`usage[backendId]`), and — for the viewed backend only — the Statistics page's own
// (`usageView`), fetched for whatever range / custom span / stage filter the page has set
// (`usageViewQuery`) and refetched when that changes or the poll ticks. The kind filter
// is client-side and never refetches. Best-effort throughout: a standard/old server (no
// /v1/usage) or any error yields null and the stats surfaces simply hide.
//
// The outcome queue (lib/usageOutcome.ts) is flushed from here too: at launch, on
// every poll, and — crucially — BEFORE the post-session refetch, so the numbers
// that refetch brings back already include the session that just ended.
//
// What the poll costs is kept to what someone can see. Every pass allocates the parsed
// documents, and the main webview kept that memory: ~2.2 MB a minute with the window
// closed to the tray, flat with the poll stretched to 10 minutes (A/B, 2026-09-26). So
// the Statistics page's two documents are fetched only while that page is open, and a
// hidden main window polls only every HIDDEN_EVERY ticks — the chip still shows the
// per-backend numbers — and catches up the moment it is shown again.

import { useApp } from "./store";
import { isTauri, getUsageStats } from "./api";
import { flushOutcomes, initOutcomeQueue, sentOutcomeCount } from "./usageOutcome";
import { backendForProfile, homeTargetProfile } from "./dictation/dictation";
import { effectiveServerKind } from "./serverKind";
import { effectiveServerUrl } from "./backends";
import { hasOwn, ownProp } from "./own";
import { toUsageQuery, type UsagePageQuery, viewSigSource } from "./usageDerive";
import type { Backend } from "./types";
import { isWindowHidden, onWindowHiddenChange } from "./windowVisibility";

const POLL_MS = 30_000; // steady refresh cadence
const HIDDEN_EVERY = 10; // while the main window is hidden: one pass per 5 minutes
const AFTER_SESSION_MS = 1_500; // the server records usage in its post-request finally
const EVICT_DEBOUNCE_MS = 1_000; // a dropped usage key (key rotation / URL override typed per keystroke)
export const TREND_DAYS = 30; // the Home strip's and the chip's fixed window

let started = false;
let pollingAll = false;
let rerunRequested = false; // a refresh asked for mid-pass → run one more pass with the latest backends
let statsPagesOpen = 0; // mounted Statistics pages; their documents are fetched only while > 0
let skippedTicks = 0; // poll ticks passed over while hidden
let pageMissed = false; // a hidden pass ran with a Statistics page open, skipping its documents
// Bumped on every committed success. A stale-marking miss (`reopened`) checks it against the value
// it captured before its fetch: a same-query success that landed meanwhile — another pass, the
// reopen fetch — is seconds old, so the miss must not mark it failed. A counter, not the document
// reference: setUsageView/Year keep the old reference when a success re-answers identical data.
let viewGen = 0;
let yearGen = 0;
// The view signature a fetch confirmed during this visit and no later fetch missed (null after a
// reopen, a hidden pass or a miss): only a confirmed 365-day view may stand in for the calendar's year.
let viewFreshSig: string | null = null;

/** The Statistics page documents are wanted: the page is open and can be seen. */
function statsPageShown(): boolean {
  return statsPagesOpen > 0 && !isWindowHidden();
}

/** The Statistics page calls this on mount (and the returned cleanup on unmount): its two
 *  documents are fetched now, and by the poll only while a page is open. */
export function openStatisticsPage(): () => void {
  statsPagesOpen++;
  if (statsPagesOpen === 1) {
    // Reopened: what the store kept is from the last visit (the poll leaves it alone while the
    // page is closed), so a miss now marks it failed rather than presenting it as current.
    // These fetches cover any hidden pass the previous visit missed.
    pageMissed = false;
    viewFreshSig = null;
    void refreshView(true).catch(() => {});
    void refreshYear(true, true).catch(() => {});
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    // No page left to want the skipped documents; the next mount fetches fresh.
    if (--statsPagesOpen === 0) pageMissed = false;
  };
}

/** The Backend whose usage the chip + Home stats reflect: the Profile currently
 *  dictating, else the home target Profile (so an idle dock previews the same
 *  numbers Home shows), falling back to the first Backend. */
export function activeStatsBackend(s = useApp.getState()): Backend | undefined {
  const profile = s.activeProfile
    ? s.profiles.find((p) => p.id === s.activeProfile)
    : homeTargetProfile(s.profiles, s.settings.homeProfileId);
  return backendForProfile(profile, s.backends);
}

/** The viewer's IANA zone ("Europe/Zurich"), so the server reckons days — and the DST
 *  change a 90-day window crosses — the way the viewer's calendar does. Undefined when the
 *  runtime cannot name one; the server then falls back to its own local zone. */
export function viewerTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** The Backend the usage poll fetches stats for: the user's pick when it
 *  has usage, else the home-target backend, else the first backend that has usage. */
export function viewStatsBackend(s = useApp.getState()): Backend | undefined {
  const withUsage = s.backends.filter((b) => !!ownProp(s.usage, b.id));
  const defaultId = homeTargetProfile(s.profiles, s.settings.homeProfileId)?.backendId ?? s.backends[0]?.id;
  return withUsage.find((b) => b.id === s.usageViewBackendId) ?? withUsage.find((b) => b.id === defaultId) ?? withUsage[0];
}

/** The signature a view document answers: backend + target + the exact wire query.
 *  usageDerive's viewSigParts / viewSigSource / viewSigBackend read it back, so keep that order. */
export function viewSignature(backend: Backend, target: string, q: UsagePageQuery, tz: string | undefined): string {
  return JSON.stringify([backend.id, target, toUsageQuery(q, tz)]);
}

/** Whether two view signatures name the same backend + target (whatever their queries): only
 *  such a document may stand in for another while it loads. False for any malformed signature. */
export function sameViewSource(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = viewSigSource(a);
  return x !== null && x === viewSigSource(b);
}

/** The calendar's query for a page query: the last 365 days under the same stage filter.
 *  Null when the page's own document already spans a year (the 365 / All presets). */
export function yearPageQuery(q: UsagePageQuery): UsagePageQuery | null {
  if (q.range === "365" || q.range === "all") return null;
  return { range: "365", with: q.with };
}

/** Fetch the calendar's year document beside the page's, under the same rules. `force`
 *  refetches a year it already has (the page reopening after the poll left it alone);
 *  `reopened` marks a kept same-query year failed on a miss, as refreshView's does. */
async function refreshYear(force = false, reopened = false): Promise<void> {
  const s = useApp.getState();
  const backend = viewStatsBackend(s);
  if (!backend) return;
  const q = yearPageQuery(s.usageViewQuery);
  if (!q) return;
  const target = effectiveServerUrl(backend, s.settings);
  const tz = viewerTimeZone();
  const sig = viewSignature(backend, target, q, tz);
  if (s.usageYear?.sig === sig && s.usageYear.stats && !s.usageYear.failed && !force) return; // the poll forces it; a filter change reuses it, mid-pass too (a failed, carried year is retried)
  const gen = yearGen;
  const stats = await getUsageStats({ serverUrl: target, backendId: backend.id, query: toUsageQuery(q, tz) });
  const now = useApp.getState();
  const cur = viewStatsBackend(now);
  if (!cur || cur.id !== backend.id) return;
  const nq = yearPageQuery(now.usageViewQuery);
  if (!nq || viewSignature(cur, effectiveServerUrl(cur, now.settings), nq, tz) !== sig) return;
  if (stats === null && now.usageYear?.sig === sig && (!reopened || yearGen !== gen)) return;
  now.setUsageYear(sig, stats);
  if (stats !== null) yearGen++;
}

/** Coming back from 1 year: the page's own 365-day document — once a fetch this visit confirmed
 *  it — answers the calendar's year query exactly (same signature), so it becomes the year
 *  document without a fetch. False when it cannot stand in (another stage filter, a failed,
 *  missing or not-yet-confirmed view: a reopen or hidden pass left it possibly days old). */
function seedYearFromView(s = useApp.getState()): boolean {
  const backend = viewStatsBackend(s);
  const q = yearPageQuery(s.usageViewQuery);
  if (!backend || !q) return false;
  const sig = viewSignature(backend, effectiveServerUrl(backend, s.settings), q, viewerTimeZone());
  const view = s.usageView;
  if (view?.sig !== sig || sig !== viewFreshSig || !view.stats || view.failed) return false;
  s.setUsageYear(sig, view.stats);
  yearGen++;
  return true;
}

/** The page's documents for the current query were confirmed this visit and are not failed — a
 *  direct fetch that missed (or was overtaken by a query change) leaves this false. */
function pageConfirmed(s = useApp.getState()): boolean {
  const backend = viewStatsBackend(s);
  if (!backend) return false;
  const target = effectiveServerUrl(backend, s.settings);
  const tz = viewerTimeZone();
  const sig = viewSignature(backend, target, s.usageViewQuery, tz);
  const view = s.usageView;
  if (view?.sig !== sig || sig !== viewFreshSig || !view.stats || view.failed) return false;
  const q = yearPageQuery(s.usageViewQuery);
  if (!q) return true;
  const year = s.usageYear;
  return year?.sig === viewSignature(backend, target, q, tz) && !!year.stats && !year.failed;
}

/** Fetch the Statistics page's document for the current query against the viewed
 *  backend. A response for a query that is no longer current is dropped. `reopened`: the
 *  page just mounted, so a kept same-query document may be days old — a miss marks it
 *  failed (still shown, as older data) instead of keeping it as if it were current. */
async function refreshView(reopened = false): Promise<void> {
  const s = useApp.getState();
  const backend = viewStatsBackend(s);
  if (!backend) return;
  const target = effectiveServerUrl(backend, s.settings);
  const tz = viewerTimeZone();
  const q = s.usageViewQuery;
  const sig = viewSignature(backend, target, q, tz);
  const gen = viewGen;
  const stats = await getUsageStats({ serverUrl: target, backendId: backend.id, query: toUsageQuery(q, tz) });
  const now = useApp.getState();
  const cur = viewStatsBackend(now);
  if (!cur || cur.id !== backend.id) return;
  if (viewSignature(cur, effectiveServerUrl(cur, now.settings), now.usageViewQuery, tz) !== sig) return;
  // A miss revokes this query's confirmation (the kept document may now be hours old), unless a
  // success landed while this fetch was out; the next success confirms it again.
  if (stats === null && sig === viewFreshSig && viewGen === gen) viewFreshSig = null;
  // Keep the last-known on a transient miss — and on a stale-marking one too when a success
  // landed while this fetch was out (that document is current, not the kept one).
  if (stats === null && now.usageView?.sig === sig && (!reopened || viewGen !== gen)) return;
  now.setUsageView(sig, stats);
  if (stats !== null) {
    viewGen++;
    viewFreshSig = sig;
  }
}

async function refreshOne(backend: Backend): Promise<void> {
  const { connections, usage, setUsage } = useApp.getState();
  // Skip a server we KNOW is standard (no /v1/usage); "unknown" ⇒ try anyway.
  if (effectiveServerKind(backend, ownProp(connections, backend.id)) === "standard") {
    // Don't clobber a backend that has been serving usage just because the
    // connection probe hasn't run yet — only seed null if we've never recorded a
    // value. Test key-presence (not truthiness): `!usage[id]` is true for the null
    // we just wrote, so it would re-set null every poll, and setUsage always spreads
    // a fresh `usage` object — churning a cross-window dictation://update each tick.
    // Own-property test: `in` is true for `constructor`/`toString`/… via the prototype, so the
    // seed that would shadow the inherited member never ran and the map stayed poisoned.
    if (!hasOwn(usage, backend.id)) setUsage(backend.id, null);
    return;
  }
  const target = effectiveServerUrl(backend, useApp.getState().settings);
  const stats = await getUsageStats({
    serverUrl: target,
    backendId: backend.id,
    query: { days: TREND_DAYS, tz: viewerTimeZone() },
  });
  // Mirror the Backends connection-test guard (+ upsertBackend's invalidation): a slow fetch against
  // the OLD server can resolve AFTER the user edited this backend's URL/key (store dropped the stale
  // usage) or removed it. Bail unless the backend still exists with the same target — else we'd flash
  // the old server's counts under the edited backend, or re-add a dangling usage[removedId] the rerun
  // (live backends only) never clears.
  const st = useApp.getState();
  const cur = st.backends.find((x) => x.id === backend.id);
  if (!cur || cur.serverUrl !== backend.serverUrl || cur.hasApiKey !== backend.hasApiKey) return;
  // …and the URL OVERRIDE, which is where this request actually went. It is the third
  // invalidation trigger `setUrlOverride` fires on, and comparing only `serverUrl` let a fetch
  // already in flight against the old address resolve afterwards and re-install its counters
  // under a backend that now points somewhere else — undoing the invalidation that just ran.
  if (effectiveServerUrl(cur, st.settings) !== target) return;
  // `series` is server-supplied (Rust caps it at 3,700). We asked for TREND_DAYS buckets, so
  // anything past that is not data we can use — but it WOULD be stored and then re-serialized by
  // setUsage's two stringify passes on the main thread, every 30s, for every backend, forever.
  if (stats?.series && stats.series.length > TREND_DAYS) {
    stats.series = stats.series.slice(-TREND_DAYS);
  }
  // Keep the last-known value on a transient miss — only commit null the first
  // time. Key-presence (not truthiness) so an already-null backend isn't re-set to
  // null every poll (which would spread a fresh `usage` object and churn the
  // cross-window update); a real value still overwrites since stats!==null falls through.
  if (stats === null && hasOwn(usage, backend.id)) return;
  setUsage(backend.id, stats);
}

/** Refresh usage for EVERY configured backend (sequentially, best-effort) so the
 *  usage view can switch between backends instantly from the store. Guarded so
 *  overlapping polls don't stack. `direct`: the show handler just fetched the page's documents,
 *  with `sentOutcomeCount()` at `at`; `confirmed` settles to whether they landed. The pass skips
 *  its own page step only when they did and no outcome was delivered since. */
async function refreshAll(direct?: { at: number; confirmed: Promise<boolean> }): Promise<void> {
  // Already polling: don't stack a second pass, but record the request so we run once more after —
  // otherwise a refresh triggered by a backend edit (which deleted that backend's cached usage) is
  // dropped and the just-edited backend stays blank until the next 30s tick.
  if (pollingAll) {
    rerunRequested = true;
    return;
  }
  pollingAll = true;
  let skipPage = direct;
  try {
    // Outcomes first, so a session that ended while the server was unreachable lands
    // before the numbers are re-read (the server folds it into the same document).
    await flushOutcomes();
    do {
      rerunRequested = false;
      const fetched = skipPage; // the first iteration only: a rerun fetches the page as usual
      skipPage = undefined;
      for (const b of useApp.getState().backends) {
        try {
          await refreshOne(b);
        } catch {
          /* one backend failing must not stop the rest */
        }
      }
      if (statsPageShown()) {
        // The show handler fetched them a moment ago: refetching the same documents is only
        // worth it when that fetch missed, or the flush above delivered an outcome they may not
        // include.
        const caughtUp =
          fetched !== undefined && (await fetched.confirmed) && fetched.at === sentOutcomeCount();
        // A hidden pass skipped the page's documents, so what it shows may be hours old: a
        // miss now marks it failed, as on a reopen. The show handler normally fetches them
        // itself and consumes the flag first; one still set here is consumed the same way.
        const stale = pageMissed;
        pageMissed = false;
        if (!caughtUp) {
          try {
            await refreshView(stale);
          } catch {
            /* the page keeps its last document */
          }
          try {
            await refreshYear(true, stale);
          } catch {
            /* the calendar keeps its last year */
          }
        }
      } else if (statsPagesOpen > 0) {
        // Hidden with the page open — whichever pass this is (tick, after-session, backend
        // edit): the show handler fetches the page's documents then.
        pageMissed = true;
        viewFreshSig = null;
      }
    } while (rerunRequested); // re-reads the latest backends snapshot on the rerun
  } finally {
    pollingAll = false;
  }
}

export function initUsageController(): void {
  if (!isTauri || started) return;
  started = true;

  // The persisted queue loads before the first pass, so a restart posts what the
  // previous run could not — refreshAll flushes again on every pass.
  void initOutcomeQueue().finally(() => void refreshAll()).catch(() => {});
  setInterval(() => {
    if (isWindowHidden() && ++skippedTicks < HIDDEN_EVERY) return;
    skippedTicks = 0;
    void refreshAll();
  }, POLL_MS);
  // Shown again after ticks were passed over — or right after a hidden pass that skipped the
  // open page's documents (skippedTicks is 0 then): catch up now, not on the next tick. The
  // page's documents are fetched directly rather than at the end of a pass, which first
  // flushes the outcomes and then waits on every backend's trend fetch (30 s each, bounded).
  // That pass then skips its own page step when they landed and its flush delivered no outcome.
  onWindowHiddenChange((hidden) => {
    if (hidden || (skippedTicks === 0 && !pageMissed)) return;
    let direct: { at: number; confirmed: Promise<boolean> } | undefined;
    if (pageMissed && statsPageShown()) {
      // Possibly hours old, so a miss marks them failed, as on a reopen.
      const at = sentOutcomeCount();
      pageMissed = false;
      const view = refreshView(true).catch(() => {});
      const year = refreshYear(true, true).catch(() => {});
      direct = { at, confirmed: Promise.all([view, year]).then(() => pageConfirmed()) };
    }
    if (skippedTicks > 0) {
      skippedTicks = 0;
      void refreshAll(direct);
    }
  });

  let afterTimer: ReturnType<typeof setTimeout> | undefined;
  let evictTimer: ReturnType<typeof setTimeout> | undefined;
  useApp.subscribe((state, prev) => {
    // Refetch when the set of backends changes (added / removed / url, key presence or
    // server-type edited). The init-time refreshAll() above covers the first load, so
    // comparing against prev suffices.
    const bKey = (bs: typeof state.backends) =>
      bs.map((b) => b.id + "\0" + b.serverUrl + "\0" + b.hasApiKey + "\0" + (b.kind ?? "")).join("\n");
    if (bKey(state.backends) !== bKey(prev.backends)) {
      void refreshAll();
    } else if (
      (state.usage !== prev.usage &&
        state.backends.some((b) => hasOwn(prev.usage, b.id) && !hasOwn(state.usage, b.id))) ||
      (state.settings.sync?.urlOverrides !== prev.settings.sync?.urlOverrides &&
        (evictTimer !== undefined || state.backends.some((b) => !hasOwn(state.usage, b.id))))
    ) {
      // A live backend's cached usage was dropped without bKey moving — an API-key rotation
      // (forgetBackendCaches) or a URL override (setUrlOverride): refetch it soon, not on the
      // next tick. Debounced: the override field writes on every keystroke, and a pass per
      // half-typed address would send the key to each of them. Only the FIRST keystroke
      // evicts (the key is already gone for the rest), so every override change re-arms the
      // pass while one is pending OR a live backend's usage is still missing — the latter
      // covers a keystroke landing while the debounced pass's fetch to the half-typed address
      // is still in flight (no timer then, and that fetch bails on the moved target without
      // re-adding the key). It runs 1 s after the LAST change. This fires only on an override
      // change and refreshAll folds overlapping passes, so it cannot loop.
      clearTimeout(evictTimer);
      evictTimer = setTimeout(() => {
        evictTimer = undefined;
        void refreshAll();
      }, EVICT_DEBOUNCE_MS);
    }
    // Refetch shortly after a dictation session ends (idle transition) — the server
    // records usage in its post-request finally, so today's totals just moved. The
    // outcome settleIdle enqueued is flushed at the head of that pass (refreshAll).
    if (prev.status !== "idle" && state.status === "idle") {
      clearTimeout(afterTimer);
      afterTimer = setTimeout(() => void refreshAll(), AFTER_SESSION_MS);
    }
    // The Statistics page changed what it asks for, or which backend it looks at — picked, or
    // the implicit default moving under it (the home profile cycled from the chip, a sync pull
    // rewriting the profiles): fetch that document now rather than on the next 30 s tick.
    // Usage-map changes are left out: refreshAll refreshes the view after its per-backend loop.
    const viewMoved =
      state.usageViewQuery !== prev.usageViewQuery ||
      state.usageViewBackendId !== prev.usageViewBackendId ||
      ((state.profiles !== prev.profiles || state.settings.homeProfileId !== prev.settings.homeProfileId) &&
        viewStatsBackend(state)?.id !== viewStatsBackend(prev)?.id);
    if (viewMoved && statsPageShown()) {
      void refreshView().catch(() => {});
      // On the 1 year / All presets nothing kept the year document current. Coming back from
      // 1 year, the polled 365-day view is that year (seeded, no fetch); otherwise — the All
      // preset, a stage filter changed alongside, a failed or missing view — it is refetched,
      // and like a reopen a miss marks the kept year failed rather than current. A sub-year →
      // sub-year change still reuses the polled year.
      const fromYear = !yearPageQuery(prev.usageViewQuery);
      if (!(fromYear && prev.usageViewQuery.range === "365" && seedYearFromView(state)))
        void refreshYear(fromYear, fromYear).catch(() => {});
    } else if (viewMoved && statsPagesOpen > 0) {
      // Moved while the window is hidden with the page open: record the miss the way a hidden
      // refreshAll pass does, so the show handler catches up even when no tick was skipped.
      pageMissed = true;
      viewFreshSig = null;
    }
  });
}
