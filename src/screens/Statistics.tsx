// Dedicated Statistics page — the full usage document lifted off Home so the home
// screen stays focused on dictation: per-kind tiles, the stacked columns by kind, the
// Stages / Dictation / Rhythm panels. Reached from the sidebar, the "View statistics →"
// link on Home, or a Home small multiple (`?scope=file` preselects that kind). A backend
// selector at the top switches which backend's usage you're viewing.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { StatisticsView } from "@/components/UsageStats";
import { PageHeader } from "@/components/ui";
import { parseScope, type UsageScope } from "@/lib/usageDerive";

export default function Statistics() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Read once on mount; the control owns it from there and mirrors it back to the URL so
  // a reload (or the sidebar's back) lands on the same scope.
  const [scope, setScopeState] = useState<UsageScope>(() => parseScope(searchParams.get("scope")));
  const setScope = (s: UsageScope) => {
    setScopeState(s);
    setSearchParams(s === "all" ? {} : { scope: s }, { replace: true });
  };
  return (
    <div className="page page-cards">
      <PageHeader eyebrow="faster-whisper · usage" title="Statistics">
        Everything you’ve dictated, transcribed and translated — today and all-time — by kind, with the stages each run
        used, how dictations landed, and your rhythm over the last 90 days.
      </PageHeader>

      <div className="mt-8">
        <StatisticsView scope={scope} onScope={setScope} />
      </div>
    </div>
  );
}
