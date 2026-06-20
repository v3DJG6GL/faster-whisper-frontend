// Usage-stats controller (runs in the main window). Keeps the active backend's
// usage (GET /v1/usage) fresh in the store so BOTH the Home stats section
// (React) and the chip readout (the separate overlay webview, fed via
// overlay.ts) can read it. Like overlay.ts it's a store-subscribed singleton.
//
// One fetch pulls today + lifetime totals AND a 90-day daily series; the Home
// chart slices 7/30/90 days from that series client-side, so changing the range
// never refetches. Best-effort throughout: a standard/old server (no /v1/usage)
// or any error yields null and the stats surfaces simply hide.

import { useApp } from "./store";
import { isTauri, getUsageStats } from "./api";
import { backendForProfile, homeTargetProfile } from "./dictation";
import { effectiveServerKind } from "./serverKind";
import type { Backend } from "./types";

const POLL_MS = 30_000; // steady refresh cadence
const AFTER_SESSION_MS = 1_500; // the server records usage in its post-request finally
export const TREND_DAYS = 90; // fetched once; the chart slices 7/30/90 from it

let started = false;
let pollingAll = false;

/** The Backend whose usage the chip + Home stats reflect: the Profile currently
 *  dictating, else the home target Profile (so an idle dock previews the same
 *  numbers Home shows), falling back to the first Backend. */
export function activeStatsBackend(s = useApp.getState()): Backend | undefined {
  const profile = s.activeProfile
    ? s.profiles.find((p) => p.id === s.activeProfile)
    : homeTargetProfile(s.profiles, s.settings.homeProfileId);
  return backendForProfile(profile, s.backends);
}

/** The client's local-midnight epoch (seconds) — the server's "today" boundary. */
function localMidnightEpoch(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
}

async function refreshOne(backend: Backend): Promise<void> {
  const { connections, usage, setUsage } = useApp.getState();
  // Skip a server we KNOW is standard (no /v1/usage); "unknown" ⇒ try anyway.
  if (effectiveServerKind(backend, connections[backend.id]) === "standard") {
    // Don't clobber a backend that has been serving usage just because the
    // connection probe hasn't run yet — only seed null if we've never recorded a
    // value. Test key-presence (not truthiness): `!usage[id]` is true for the null
    // we just wrote, so it would re-set null every poll, and setUsage always spreads
    // a fresh `usage` object — churning a cross-window dictation://update each tick.
    if (!(backend.id in usage)) setUsage(backend.id, null);
    return;
  }
  const stats = await getUsageStats({
    serverUrl: backend.serverUrl,
    backendId: backend.id,
    tzMidnight: localMidnightEpoch(),
    days: TREND_DAYS,
    bucket: "day",
  });
  // Keep the last-known value on a transient miss — only commit null the first
  // time. Key-presence (not truthiness) so an already-null backend isn't re-set to
  // null every poll (which would spread a fresh `usage` object and churn the
  // cross-window update); a real value still overwrites since stats!==null falls through.
  if (stats === null && backend.id in usage) return;
  setUsage(backend.id, stats);
}

/** Refresh usage for EVERY configured backend (sequentially, best-effort) so the
 *  usage view can switch between backends instantly from the store. Guarded so
 *  overlapping polls don't stack. */
async function refreshAll(): Promise<void> {
  if (pollingAll) return;
  pollingAll = true;
  try {
    for (const b of useApp.getState().backends) {
      try {
        await refreshOne(b);
      } catch {
        /* one backend failing must not stop the rest */
      }
    }
  } finally {
    pollingAll = false;
  }
}

export function initUsageController(): void {
  if (!isTauri || started) return;
  started = true;

  void refreshAll();
  setInterval(() => void refreshAll(), POLL_MS);

  let lastBackends = useApp.getState().backends;
  let afterTimer: ReturnType<typeof setTimeout> | undefined;
  useApp.subscribe((state, prev) => {
    // Refetch when the set of backends changes (added / removed / url edited).
    if (state.backends !== lastBackends) {
      lastBackends = state.backends;
      void refreshAll();
    }
    // Refetch shortly after a dictation session ends (idle transition) — the server
    // records usage in its post-request finally, so today's totals just moved.
    if (prev.status !== "idle" && state.status === "idle") {
      clearTimeout(afterTimer);
      afterTimer = setTimeout(() => void refreshAll(), AFTER_SESSION_MS);
    }
  });
}
