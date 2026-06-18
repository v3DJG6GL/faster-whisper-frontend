// Dedicated Statistics page — the full usage trend chart (and stat tiles) lifted off
// Home so the home screen stays focused on dictation. Reached from the sidebar or the
// "View statistics →" link on Home. A backend selector at the top switches which
// backend's usage you're viewing (when more than one has stats).

import { StatisticsView } from "@/components/UsageStats";

export default function Statistics() {
  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <div className="font-mono text-[11px] uppercase tracking-label text-accent">faster-whisper · usage</div>
      <h1 className="mt-2 font-display text-[30px] font-bold tracking-tight text-text">Statistics</h1>
      <p className="mt-2 max-w-md text-[13.5px] text-dim">
        Everything you’ve dictated — today and all-time — with the full trend over the last 7, 30 or 90 days.
        Hover the chart for a day’s detail.
      </p>

      <div className="mt-8">
        <StatisticsView />
      </div>
    </div>
  );
}
