// Usage-stats controller (runs in the main window). Keeps the active backend's
// usage (GET /v1/usage) fresh in the store so BOTH the Home stats section
// (React) and the chip readout (the separate overlay webview, fed via
// overlay.ts) can read it. Like overlay.ts it's a store-subscribed singleton.
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

import { useApp } from "./store";
import { isTauri, getUsageStats } from "./api";
import { flushOutcomes, initOutcomeQueue } from "./usageOutcome";
import { backendForProfile, homeTargetProfile } from "./dictation";
import { effectiveServerKind } from "./serverKind";
import { effectiveServerUrl } from "./backends";
import { hasOwn, ownProp } from "./own";
import { toUsageQuery, type UsagePageQuery } from "./usageDerive";
import type { Backend } from "./types";

const POLL_MS = 30_000; // steady refresh cadence
const AFTER_SESSION_MS = 1_500; // the server records usage in its post-request finally
export const TREND_DAYS = 30; // the Home strip's and the chip's fixed window

let started = false;
let pollingAll = false;
let rerunRequested = false; // a refresh asked for mid-pass → run one more pass with the latest backends

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

/** The signature a view document answers: backend + target + the exact wire query. */
export function viewSignature(backend: Backend, target: string, q: UsagePageQuery, tz: string | undefined): string {
  return JSON.stringify([backend.id, target, toUsageQuery(q, tz)]);
}

/** Fetch the Statistics page's document for the current query against the viewed
 *  backend. A response for a query that is no longer current is dropped. */
async function refreshView(): Promise<void> {
  const s = useApp.getState();
  const backend = viewStatsBackend(s);
  if (!backend) return;
  const target = effectiveServerUrl(backend, s.settings);
  const tz = viewerTimeZone();
  const q = s.usageViewQuery;
  const sig = viewSignature(backend, target, q, tz);
  const stats = await getUsageStats({ serverUrl: target, backendId: backend.id, query: toUsageQuery(q, tz) });
  const now = useApp.getState();
  const cur = viewStatsBackend(now);
  if (!cur || cur.id !== backend.id) return;
  if (viewSignature(cur, effectiveServerUrl(cur, now.settings), now.usageViewQuery, tz) !== sig) return;
  if (stats === null && now.usageView?.sig === sig) return; // keep the last-known on a transient miss
  now.setUsageView(sig, stats);
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
 *  overlapping polls don't stack. */
async function refreshAll(): Promise<void> {
  // Already polling: don't stack a second pass, but record the request so we run once more after —
  // otherwise a refresh triggered by a backend edit (which deleted that backend's cached usage) is
  // dropped and the just-edited backend stays blank until the next 30s tick.
  if (pollingAll) {
    rerunRequested = true;
    return;
  }
  pollingAll = true;
  try {
    // Outcomes first, so a session that ended while the server was unreachable lands
    // before the numbers are re-read (the server folds it into the same document).
    await flushOutcomes();
    do {
      rerunRequested = false;
      for (const b of useApp.getState().backends) {
        try {
          await refreshOne(b);
        } catch {
          /* one backend failing must not stop the rest */
        }
      }
      try {
        await refreshView();
      } catch {
        /* the page keeps its last document */
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
  void initOutcomeQueue().finally(() => void refreshAll());
  setInterval(() => void refreshAll(), POLL_MS);

  let afterTimer: ReturnType<typeof setTimeout> | undefined;
  useApp.subscribe((state, prev) => {
    // Refetch when the set of backends changes (added / removed / url edited). The init-time
    // refreshAll() above covers the first load, so comparing against prev suffices.
    if (state.backends !== prev.backends) {
      void refreshAll();
    }
    // Refetch shortly after a dictation session ends (idle transition) — the server
    // records usage in its post-request finally, so today's totals just moved. The
    // outcome settleIdle enqueued is flushed at the head of that pass (refreshAll).
    if (prev.status !== "idle" && state.status === "idle") {
      clearTimeout(afterTimer);
      afterTimer = setTimeout(() => void refreshAll(), AFTER_SESSION_MS);
    }
    // The Statistics page changed what it asks for, or which backend it looks at: fetch
    // that document now rather than on the next 30 s tick.
    if (state.usageViewQuery !== prev.usageViewQuery || state.usageViewBackendId !== prev.usageViewBackendId) {
      void refreshView().catch(() => {});
    }
  });
}
