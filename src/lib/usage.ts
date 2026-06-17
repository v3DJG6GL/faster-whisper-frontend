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
import { homeTargetProfile } from "./dictation";
import { effectiveServerKind } from "./serverKind";
import type { Backend } from "./types";

const POLL_MS = 30_000; // steady refresh cadence
const AFTER_SESSION_MS = 1_500; // the server records usage in its post-request finally
export const TREND_DAYS = 90; // fetched once; the chart slices 7/30/90 from it

let started = false;
let inFlight = false;

/** The Backend whose usage the chip + Home stats reflect: the Profile currently
 *  dictating, else the home target Profile (so an idle dock previews the same
 *  numbers Home shows), falling back to the first Backend. */
export function activeStatsBackend(s = useApp.getState()): Backend | undefined {
  const profile = s.activeProfile
    ? s.profiles.find((p) => p.id === s.activeProfile)
    : homeTargetProfile(s.profiles, s.settings.homeProfileId);
  return s.backends.find((b) => b.id === profile?.backendId) ?? s.backends[0];
}

/** The client's local-midnight epoch (seconds) — the server's "today" boundary. */
function localMidnightEpoch(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
}

async function refresh(backend: Backend | undefined): Promise<void> {
  if (!backend || inFlight) return;
  const { connections, usage, setUsage } = useApp.getState();
  // Skip a server we KNOW is standard (no /v1/usage); "unknown" ⇒ try anyway.
  if (effectiveServerKind(backend, connections[backend.id]) === "standard") {
    setUsage(backend.id, null);
    return;
  }
  inFlight = true;
  try {
    const stats = await getUsageStats({
      serverUrl: backend.serverUrl,
      backendId: backend.id,
      tzMidnight: localMidnightEpoch(),
      days: TREND_DAYS,
      bucket: "day",
    });
    // Keep the last-known-good value on a transient miss — only commit null when
    // we've never succeeded for this backend (genuinely unsupported/unreachable).
    if (stats === null && usage[backend.id]) return;
    setUsage(backend.id, stats);
  } finally {
    inFlight = false;
  }
}

export function initUsageController(): void {
  if (!isTauri || started) return;
  started = true;

  void refresh(activeStatsBackend());
  setInterval(() => void refresh(activeStatsBackend()), POLL_MS);

  let lastBackendId = activeStatsBackend()?.id;
  let afterTimer: ReturnType<typeof setTimeout> | undefined;
  useApp.subscribe((state, prev) => {
    // Re-target immediately when the active/home backend changes.
    const b = activeStatsBackend(state);
    if (b?.id && b.id !== lastBackendId) {
      lastBackendId = b.id;
      void refresh(b);
    }
    // Refetch shortly after a dictation session ends (idle transition).
    if (prev.status !== "idle" && state.status === "idle") {
      clearTimeout(afterTimer);
      afterTimer = setTimeout(() => void refresh(activeStatsBackend()), AFTER_SESSION_MS);
    }
  });
}
