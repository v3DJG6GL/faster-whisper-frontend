// Dedicated Statistics page — the full usage trend chart (and stat tiles) lifted off
// Home so the home screen stays focused on dictation. Reached from the sidebar or the
// "View statistics →" link on Home. Scoped to the same backend Home dictates against.

import { useApp } from "@/lib/store";
import { homeTargetProfile } from "@/lib/dictation";
import { StatisticsView } from "@/components/UsageStats";
import type { Backend } from "@/lib/types";

export default function Statistics() {
  const profiles = useApp((s) => s.profiles);
  const backends = useApp((s) => s.backends);
  const homeProfileId = useApp((s) => s.settings.homeProfileId);

  // Same backend resolution as Home's hero: the targeted profile's backend, else the
  // first configured backend — so the figures match what the home strip + chip show.
  const target = homeTargetProfile(profiles, homeProfileId);
  const backend: Backend | undefined =
    backends.find((b) => b.id === target?.backendId) ?? backends[0];

  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <div className="font-mono text-[11px] uppercase tracking-label text-accent">faster-whisper · usage</div>
      <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Statistics</h1>
      <p className="mt-2 max-w-md text-[13.5px] text-dim">
        Everything you’ve dictated — today and all-time — with the full trend over the last 7, 30 or 90 days.
        Hover the chart for a day’s detail.
      </p>

      <div className="mt-8">
        <StatisticsView backend={backend} />
      </div>
    </div>
  );
}
