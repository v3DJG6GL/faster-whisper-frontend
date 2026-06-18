// Dedicated Statistics page — the full usage trend chart (and stat tiles) lifted off
// Home so the home screen stays focused on dictation. Reached from the sidebar or the
// "View statistics →" link on Home. A backend selector at the top switches which
// backend's usage you're viewing (when more than one has stats).

import { StatisticsView } from "@/components/UsageStats";
import { PageHeader } from "@/components/ui";

export default function Statistics() {
  return (
    <div className="mx-auto max-w-[900px] px-10 py-12">
      <PageHeader eyebrow="faster-whisper · usage" title="Statistics">
        Everything you’ve dictated — today and all-time — with the full trend over the last 7, 30 or 90 days.
        Hover the chart for a day’s detail.
      </PageHeader>

      <div className="mt-8">
        <StatisticsView />
      </div>
    </div>
  );
}
